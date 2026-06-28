// Pencatatan mutasi stok ke kartu stok + penyesuaian (audit trail).

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { warehouseLabel, normalizeWarehouseKode } from '@/lib/api/warehouses';
import { resolveProductGudangKode, setProductWarehouseStock } from '@/lib/api/product-warehouse';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import type { AuthContext } from '@/types/auth';

type StockLedgerProduct = Record<string, unknown> & {
  id?: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  hargaBeli?: number | string;
  tenantId?: string;
  gudangKode?: string | null;
};

interface RecordMasterStockChangeParams {
  tenantId: string;
  product: StockLedgerProduct;
  gudangKode: string;
  qtyBefore: number | string;
  qtyAfter: number | string;
  auth?: AuthContext | null;
  reason?: string;
}

function genNoPenyesuaian(): string {
  const now = new Date();
  return `PS${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
}

/**
 * Catat selisih stok dari edit master produk → penyesuaian_stok + stok_kartu.
 */
export async function recordMasterProductStockChange(
  db: Db,
  {
    tenantId,
    product,
    gudangKode,
    qtyBefore,
    qtyAfter,
    auth,
    reason = 'Penyesuaian via edit master produk',
  }: RecordMasterStockChangeParams,
): Promise<{ noPenyesuaian: string; selisih: number } | null> {
  const before = parseFloat(String(qtyBefore)) || 0;
  const after = parseFloat(String(qtyAfter)) || 0;
  const selisih = after - before;
  if (Math.abs(selisih) < 1e-9) return null;

  const tid = tenantId || 'default';
  const lokasiKode = normalizeWarehouseKode(gudangKode);
  const now = new Date();
  const noPS = genNoPenyesuaian();
  const lokasiLabel = `${lokasiKode} - ${warehouseLabel(lokasiKode)}`;
  const harga = parseInt(String(product?.hargaBeli || 0), 10);

  const penyesuaianDoc = stampTenantId(tid, {
    id: uuidv4(),
    noPenyesuaian: noPS,
    tanggal: now,
    lokasi: lokasiLabel,
    lokasiKode,
    keterangan: reason,
    userId: auth?.userId || '',
    userName: auth?.name || auth?.email || '',
    source: 'MASTER_PRODUK',
    items: [{
      stokId: String(product.id),
      kode: product.kode,
      nama: product.nama,
      satuan: product.satuan,
      qtySistem: before,
      qtyAktual: after,
      selisih,
    }],
    createdAt: now,
  });

  const kartuDoc = stampTenantId(tid, {
    id: uuidv4(),
    stokId: String(product.id),
    lokasi: lokasiLabel,
    lokasiKode,
    tanggal: now,
    noTransaksi: noPS,
    keterangan: `${reason} — ${product.kode} ${product.nama}`,
    sourceType: 'PENYESUAIAN',
    masuk: selisih > 0 ? selisih : 0,
    keluar: selisih < 0 ? Math.abs(selisih) : 0,
    hargaSatuan: harga,
    penyesuaianId: penyesuaianDoc.id,
  });

  await runInTransactionOrFallback(async ({ db: txDb, session }) => {
    await txDb.collection('penyesuaian_stok').insertOne(penyesuaianDoc, txOpts(session));
    await txDb.collection('stok_kartu').insertOne(kartuDoc, txOpts(session));
    await writeAuditLog(txDb, {
      tenantId: tid,
      action: 'STOCK_ADJUSTMENT',
      entityType: 'penyesuaian_stok',
      entityId: penyesuaianDoc.id as string,
      summary: `${noPS}: ${product.kode} selisih ${selisih}`,
      ...auditActor(auth),
      metadata: { stokId: product.id, selisih, lokasiKode },
    }, session);
  });

  return { noPenyesuaian: noPS, selisih };
}

/** Saldo stok dari seluruh baris kartu stok (sumber kebenaran mutasi). */
export async function ledgerSaldoForProduct(db: Db, tenantId: string, stokId: string): Promise<number> {
  const rows = await db.collection('stok_kartu')
    .find({ tenantId: tenantId || 'default', stokId })
    .project({ masuk: 1, keluar: 1 })
    .toArray();
  return rows.reduce(
    (s, r) => s + (parseFloat(String(r.masuk)) || 0) - (parseFloat(String(r.keluar)) || 0),
    0,
  );
}

/** Samakan stok master & gudang dengan saldo kartu stok (perbaikan data ganda gudang). */
export async function reconcileProductStockFromLedger(
  db: Db,
  tenantId: string,
  product: StockLedgerProduct | null | undefined,
): Promise<{ error: string } | { stok: number; gudangKode: string }> {
  const tid = tenantId || product?.tenantId || 'default';
  const stokId = product?.id != null ? String(product.id) : '';
  if (!stokId) return { error: 'Produk tidak valid' };
  const saldo = await ledgerSaldoForProduct(db, tid, stokId);
  const gudang = resolveProductGudangKode(product);
  const result = await setProductWarehouseStock(db, tid, stokId, gudang, saldo);
  if ('error' in result && result.error) return result;
  return { stok: saldo, gudangKode: gudang };
}
