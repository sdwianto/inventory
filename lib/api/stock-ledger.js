// Pencatatan mutasi stok ke kartu stok + penyesuaian (audit trail).

import { v4 as uuidv4 } from 'uuid';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { warehouseLabel, normalizeWarehouseKode } from '@/lib/api/warehouses';
import { resolveProductGudangKode, setProductWarehouseStock } from '@/lib/api/product-warehouse';

function genNoPenyesuaian() {
  const now = new Date();
  return `PS${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
}

/**
 * Catat selisih stok dari edit master produk → penyesuaian_stok + stok_kartu.
 * @returns {{ noPenyesuaian: string, selisih: number } | null}
 */
export async function recordMasterProductStockChange(db, {
  tenantId,
  product,
  gudangKode,
  qtyBefore,
  qtyAfter,
  auth,
  reason = 'Penyesuaian via edit master produk',
}) {
  const before = parseFloat(qtyBefore) || 0;
  const after = parseFloat(qtyAfter) || 0;
  const selisih = after - before;
  if (Math.abs(selisih) < 1e-9) return null;

  const tid = tenantId || 'default';
  const lokasiKode = normalizeWarehouseKode(gudangKode);
  const now = new Date();
  const noPS = genNoPenyesuaian();
  const lokasiLabel = `${lokasiKode} - ${warehouseLabel(lokasiKode)}`;
  const harga = parseInt(product?.hargaBeli || 0, 10);

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
      stokId: product.id,
      kode: product.kode,
      nama: product.nama,
      satuan: product.satuan,
      qtySistem: before,
      qtyAktual: after,
      selisih,
    }],
    createdAt: now,
  });
  await db.collection('penyesuaian_stok').insertOne(penyesuaianDoc);

  await db.collection('stok_kartu').insertOne(stampTenantId(tid, {
    id: uuidv4(),
    stokId: product.id,
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
  }));

  return { noPenyesuaian: noPS, selisih };
}

/** Saldo stok dari seluruh baris kartu stok (sumber kebenaran mutasi). */
export async function ledgerSaldoForProduct(db, tenantId, stokId) {
  const rows = await db.collection('stok_kartu')
    .find({ tenantId: tenantId || 'default', stokId })
    .project({ masuk: 1, keluar: 1 })
    .toArray();
  return rows.reduce((s, r) => s + (parseFloat(r.masuk) || 0) - (parseFloat(r.keluar) || 0), 0);
}

/** Samakan stok master & gudang dengan saldo kartu stok (perbaikan data ganda gudang). */
export async function reconcileProductStockFromLedger(db, tenantId, product) {
  const tid = tenantId || product?.tenantId || 'default';
  const stokId = product?.id;
  if (!stokId) return { error: 'Produk tidak valid' };
  const saldo = await ledgerSaldoForProduct(db, tid, stokId);
  const gudang = resolveProductGudangKode(product);
  const result = await setProductWarehouseStock(db, tid, stokId, gudang, saldo);
  if (result?.error) return result;
  return { stok: saldo, gudangKode: gudang };
}
