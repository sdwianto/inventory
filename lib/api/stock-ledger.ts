// Pencatatan mutasi stok ke kartu stok + penyesuaian (audit trail).

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { warehouseLabel, normalizeWarehouseKode, isValidWarehouseKode, WAREHOUSE_CODES, type WarehouseCode } from '@/lib/api/warehouses';
import { resolveProductGudangKode, setProductWarehouseStock } from '@/lib/api/product-warehouse';
import { getQtyStokLokasi } from '@/lib/api/stok-lokasi';
import { txOpts } from '@/lib/api/transaction';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { nextDocNumber } from '@/lib/api/document-sequence';
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
  session?: ClientSession;
}

async function genNoPenyesuaian(db: Db, tenantId: string, session?: ClientSession): Promise<string> {
  return nextDocNumber(db, tenantId, 'PS', 'PS', session);
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
    session,
  }: RecordMasterStockChangeParams,
): Promise<{ noPenyesuaian: string; selisih: number } | null> {
  const before = parseFloat(String(qtyBefore)) || 0;
  const after = parseFloat(String(qtyAfter)) || 0;
  const selisih = after - before;
  if (Math.abs(selisih) < 1e-9) return null;

  const tid = tenantId || 'default';
  const lokasiKode = normalizeWarehouseKode(gudangKode);
  const now = new Date();
  const noPS = await genNoPenyesuaian(db, tid, session);
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

  await db.collection('penyesuaian_stok').insertOne(penyesuaianDoc, txOpts(session));
  await db.collection('stok_kartu').insertOne(kartuDoc, txOpts(session));
  await writeAuditLog(db, {
    tenantId: tid,
    action: 'STOCK_ADJUSTMENT',
    entityType: 'penyesuaian_stok',
    entityId: penyesuaianDoc.id as string,
    summary: `${noPS}: ${product.kode} selisih ${selisih}`,
    ...auditActor(auth),
    metadata: { stokId: product.id, selisih, lokasiKode },
  }, session);

  return { noPenyesuaian: noPS, selisih };
}

export type RelocateWarehouseResult =
  | { moved: number; from: WarehouseCode; to: WarehouseCode }
  | { error: string };

/**
 * Pindahkan qty SKU ke gudang baru (satu gudang per SKU) + jejak kartu stok.
 */
export async function relocateProductWarehouseWithAudit(
  db: Db,
  {
    tenantId,
    product,
    nextGudang,
    auth,
    reason,
    session,
  }: {
    tenantId: string;
    product: StockLedgerProduct;
    nextGudang: string;
    auth?: AuthContext | null;
    reason?: string;
    session?: ClientSession;
  },
): Promise<RelocateWarehouseResult> {
  const tid = tenantId || 'default';
  const stokId = product?.id != null ? String(product.id) : '';
  if (!stokId) return { error: 'Produk tidak valid' };
  const toRaw = normalizeWarehouseKode(nextGudang);
  if (!isValidWarehouseKode(toRaw)) return { error: 'Gudang produk tidak valid' };
  const to = toRaw as WarehouseCode;
  const from = resolveProductGudangKode(product);
  if (from === to) return { moved: 0, from, to };

  const qtyFrom = parseFloat(String(await getQtyStokLokasi(db, tid, stokId, from, session))) || 0;
  const qtyTo = parseFloat(String(await getQtyStokLokasi(db, tid, stokId, to, session))) || 0;
  const total = qtyFrom + qtyTo;
  const note = reason || `Reclassify gudang ${from} → ${to}`;

  if (qtyFrom > 0) {
    await recordMasterProductStockChange(db, {
      tenantId: tid,
      product,
      gudangKode: from,
      qtyBefore: qtyFrom,
      qtyAfter: 0,
      auth,
      reason: `${note} (keluar ${warehouseLabel(from)})`,
      session,
    });
  }

  const wh = await setProductWarehouseStock(db, tid, stokId, to, total, session);
  if ('error' in wh) return { error: wh.error };

  if (total > 0 && qtyTo !== total) {
    await recordMasterProductStockChange(db, {
      tenantId: tid,
      product: { ...product, gudangKode: to },
      gudangKode: to,
      qtyBefore: qtyTo,
      qtyAfter: total,
      auth,
      reason: `${note} (masuk ${warehouseLabel(to)})`,
      session,
    });
  }

  return { moved: qtyFrom, from, to };
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

export type LedgerSaldoInfo = {
  saldo: number;
  /** Ada ≥1 baris kartu — lokasi harus dibatasi saldo kartu. */
  hasActivity: boolean;
};

/** Batch saldo kartu per produk (untuk cek keluar & tampilan saldo). */
export async function ledgerSaldoForProducts(
  db: Db,
  tenantId: string,
  stokIds: string[],
  session?: ClientSession,
): Promise<Map<string, LedgerSaldoInfo>> {
  const tid = tenantId || 'default';
  const ids = [...new Set(stokIds.filter(Boolean))];
  const map = new Map<string, LedgerSaldoInfo>(
    ids.map((id) => [id, { saldo: 0, hasActivity: false }]),
  );
  if (!ids.length) return map;

  const rows = await db.collection('stok_kartu').aggregate<{
    _id: string;
    saldo: number;
    n: number;
  }>([
    { $match: { tenantId: tid, stokId: { $in: ids } } },
    {
      $group: {
        _id: '$stokId',
        saldo: {
          $sum: {
            $subtract: [{ $ifNull: ['$masuk', 0] }, { $ifNull: ['$keluar', 0] }],
          },
        },
        n: { $sum: 1 },
      },
    },
  ], txOpts(session)).toArray();

  for (const r of rows) {
    const id = String(r._id || '');
    if (!id) continue;
    map.set(id, {
      saldo: Number(r.saldo) || 0,
      hasActivity: (Number(r.n) || 0) > 0,
    });
  }
  return map;
}

/**
 * Qty yang boleh dikeluarkan dari gudang.
 * Jika sudah ada jejak kartu stok, lokasi tidak boleh melebihi max(0, saldo kartu)
 * — mencegah oversell saat stok_lokasi menggelembung (phantom / multi-gudang).
 * Tanpa jejak kartu (seed awal), percaya qty lokasi.
 */
export function availableQtyAgainstLedger(
  lokasiQty: number,
  ledger: Pick<LedgerSaldoInfo, 'saldo' | 'hasActivity'> | null | undefined,
): number {
  const onHand = Math.max(0, parseFloat(String(lokasiQty)) || 0);
  if (!ledger?.hasActivity) return onHand;
  return Math.min(onHand, Math.max(0, parseFloat(String(ledger.saldo)) || 0));
}

/**
 * Satu SKU = satu gudang home. Phantom di gudang lain di-nol-kan;
 * qty home dibatasi saldo kartu bila sudah ada mutasi.
 */
export function applyLedgerCapToWarehouseMap(
  byWh: Record<string, number> | null | undefined,
  homeGudang: string | null | undefined,
  ledger: Pick<LedgerSaldoInfo, 'saldo' | 'hasActivity'> | null | undefined,
): Record<WarehouseCode, number> {
  const home = (normalizeWarehouseKode(homeGudang || '') || 'GKERING') as WarehouseCode;
  const raw = byWh || {};
  const out = {} as Record<WarehouseCode, number>;
  for (const k of WAREHOUSE_CODES) {
    if (k !== home) {
      out[k] = 0;
      continue;
    }
    out[k] = availableQtyAgainstLedger(Number(raw[k]) || 0, ledger);
  }
  return out;
}

/** Source type yang boleh melebihi saldo kartu (koreksi / inbound). */
export function shouldEnforceLedgerOnOutbound(sourceType: string | null | undefined): boolean {
  const t = String(sourceType || '').toUpperCase();
  if (!t) return true;
  const skip = new Set([
    'PENYESUAIAN',
    'MASTER_PRODUK',
    'FP_ADJUST',
    'GRN',
    'VENDOR_RETURN_REJECTED',
    'FP_RESULT',
    'FP_DIST_RETURN',
    'REPAIR_LEDGER_LOKASI_DRIFT',
  ]);
  return !skip.has(t);
}

export async function getAvailableQtyAtLokasi(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
  lokasiKode: string | null | undefined,
  session?: ClientSession,
): Promise<number> {
  const tid = tenantId || 'default';
  const lokasiQty = parseFloat(String(await getQtyStokLokasi(db, tid, stokId, lokasiKode, session))) || 0;
  const infoMap = await ledgerSaldoForProducts(db, tid, [stokId], session);
  return availableQtyAgainstLedger(lokasiQty, infoMap.get(stokId));
}

/** Samakan stok master & gudang dengan saldo kartu stok (perbaikan data ganda gudang). */
export async function reconcileProductStockFromLedger(
  db: Db,
  tenantId: string,
  product: StockLedgerProduct | null | undefined,
  opts: { clearNegative?: boolean } = {},
): Promise<{ error: string } | { stok: number; gudangKode: string; clearedNegative?: boolean }> {
  const tid = tenantId || product?.tenantId || 'default';
  const stokId = product?.id != null ? String(product.id) : '';
  if (!stokId) return { error: 'Produk tidak valid' };
  const gudang = resolveProductGudangKode(product);
  const infoMap = await ledgerSaldoForProducts(db, tid, [stokId]);
  const info = infoMap.get(stokId) || { saldo: 0, hasActivity: false };

  // Belum ada jejak kartu: purge phantom WH saja, pertahankan qty gudang home.
  if (!info.hasActivity) {
    const homeQty = Math.max(0, parseFloat(String(await getQtyStokLokasi(db, tid, stokId, gudang))) || 0);
    const result = await setProductWarehouseStock(db, tid, stokId, gudang, homeQty);
    if ('error' in result && result.error) return result;
    return { stok: homeQty, gudangKode: gudang };
  }

  let saldo = info.saldo;
  let clearedNegative = false;
  if (saldo < -1e-9 && opts.clearNegative) {
    const cleared = await clearNegativeLedgerWithAdjustment(db, tid, product, saldo);
    if ('error' in cleared) return cleared;
    saldo = 0;
    clearedNegative = true;
  }

  const qty = Math.max(0, saldo);
  const result = await setProductWarehouseStock(db, tid, stokId, gudang, qty);
  if ('error' in result && result.error) return result;
  return { stok: qty, gudangKode: gudang, clearedNegative };
}

async function clearNegativeLedgerWithAdjustment(
  db: Db,
  tenantId: string,
  product: StockLedgerProduct | null | undefined,
  negativeSaldo: number,
): Promise<{ ok: true; noPS: string } | { error: string }> {
  const stokId = product?.id != null ? String(product.id) : '';
  if (!stokId || !(negativeSaldo < 0)) return { error: 'Saldo tidak valid untuk koreksi' };
  const tid = tenantId || 'default';
  const need = -negativeSaldo;
  const now = new Date();
  const noPS = await nextDocNumber(db, tid, 'PS', 'PS');
  const gudang = resolveProductGudangKode(product);
  const lokasiLabel = `${gudang} - ${warehouseLabel(gudang)}`;
  await db.collection('penyesuaian_stok').insertOne(stampTenantId(tid, {
    id: uuidv4(),
    noPenyesuaian: noPS,
    tanggal: now,
    lokasi: lokasiLabel,
    lokasiKode: gudang,
    keterangan: `Koreksi oversell / drift lokasi vs kartu (${product?.kode || stokId})`,
    userId: 'system',
    userName: 'system-reconcile',
    source: 'REPAIR_LEDGER_LOKASI_DRIFT',
    items: [{
      stokId,
      kode: product?.kode,
      nama: product?.nama,
      satuan: product?.satuan,
      qtyBefore: negativeSaldo,
      qtyAfter: 0,
      selisih: need,
    }],
    createdAt: now,
  }));
  await db.collection('stok_kartu').insertOne(stampTenantId(tid, {
    id: uuidv4(),
    stokId,
    lokasi: lokasiLabel,
    lokasiKode: gudang,
    tanggal: now,
    noTransaksi: noPS,
    keterangan: `Penyesuaian Stok (+) ${noPS} — koreksi drift lokasi vs kartu`,
    sourceType: 'PENYESUAIAN',
    masuk: need,
    keluar: 0,
    hargaSatuan: parseInt(String(product?.hargaBeli || 0), 10) || 0,
  }));
  return { ok: true, noPS };
}

export type StockDriftRow = {
  productId: string;
  kode: string;
  nama: string;
  gudangKode: string;
  lokasiHome: number;
  lokasiTotal: number;
  masterStok: number;
  ledgerSaldo: number;
  hasKartu: boolean;
  phantomWarehouses: string[];
  issues: string[];
};

/** Audit read-only: lokasi/master vs kartu + phantom multi-gudang. */
export async function auditTenantStockDrift(
  db: Db,
  tenantId: string,
): Promise<{ scanned: number; driftCount: number; drifts: StockDriftRow[] }> {
  const tid = tenantId || 'default';
  const products = await db.collection<StockLedgerProduct>('products')
    .find({ tenantId: tid, aktif: { $ne: false } })
    .project({ id: 1, kode: 1, nama: 1, stok: 1, gudangKode: 1 })
    .toArray();
  const ids = products.map((p) => String(p.id || '')).filter(Boolean);
  const ledgerMap = await ledgerSaldoForProducts(db, tid, ids);
  const lokasiRows = await db.collection('stok_lokasi')
    .find({ tenantId: tid, stokId: { $in: ids } })
    .project({ stokId: 1, lokasiKode: 1, qty: 1 })
    .toArray();
  const byProd = new Map<string, Record<string, number>>();
  for (const r of lokasiRows) {
    const sid = String(r.stokId || '');
    if (!sid) continue;
    if (!byProd.has(sid)) byProd.set(sid, {});
    byProd.get(sid)![String(r.lokasiKode)] = parseFloat(String(r.qty)) || 0;
  }

  const drifts: StockDriftRow[] = [];
  for (const product of products) {
    const stokId = String(product.id || '');
    if (!stokId) continue;
    const home = resolveProductGudangKode(product);
    const wh = byProd.get(stokId) || {};
    const lokasiHome = Number(wh[home]) || 0;
    const lokasiTotal = Object.values(wh).reduce((s, v) => s + (Number(v) || 0), 0);
    const info = ledgerMap.get(stokId) || { saldo: 0, hasActivity: false };
    const masterStok = parseFloat(String(product.stok)) || 0;
    const phantomWarehouses = Object.keys(wh).filter(
      (k) => k !== home && Math.abs(Number(wh[k]) || 0) > 1e-9,
    );
    const issues: string[] = [];
    if (info.hasActivity && Math.abs(lokasiHome - Math.max(0, info.saldo)) > 1e-6) {
      issues.push(`home_vs_ledger ${lokasiHome}!=${info.saldo}`);
    }
    if (Math.abs(masterStok - lokasiTotal) > 1e-6) {
      issues.push(`master_vs_lokasi ${masterStok}!=${lokasiTotal}`);
    }
    if (phantomWarehouses.length) {
      issues.push(`phantom_wh ${phantomWarehouses.join(',')}`);
    }
    if (info.hasActivity && info.saldo < -1e-9) {
      issues.push(`ledger_negative ${info.saldo}`);
    }
    if (!issues.length) continue;
    drifts.push({
      productId: stokId,
      kode: String(product.kode || ''),
      nama: String(product.nama || ''),
      gudangKode: home,
      lokasiHome,
      lokasiTotal,
      masterStok,
      ledgerSaldo: info.saldo,
      hasKartu: info.hasActivity,
      phantomWarehouses,
      issues,
    });
  }

  return { scanned: products.length, driftCount: drifts.length, drifts };
}

export type ReconcileTenantStockResult = {
  dryRun: boolean;
  clearNegative: boolean;
  scanned: number;
  reconciled: number;
  clearedNegative: number;
  skipped: number;
  wouldClearNegative: number;
  errors: Array<{ productId: string; kode?: string; error: string }>;
  drifts?: StockDriftRow[];
};

/**
 * Samakan seluruh produk tenant ke saldo kartu.
 * dryRun=true → audit saja, tanpa tulis.
 * clearNegative=true → tulis PS (+) untuk kartu negatif (ops explicit).
 */
export async function reconcileTenantStockFromLedger(
  db: Db,
  tenantId: string,
  opts: { dryRun?: boolean; clearNegative?: boolean } = {},
): Promise<ReconcileTenantStockResult> {
  const tid = tenantId || 'default';
  const dryRun = opts.dryRun === true;
  const clearNegative = opts.clearNegative === true;
  const audit = await auditTenantStockDrift(db, tid);

  const result: ReconcileTenantStockResult = {
    dryRun,
    clearNegative,
    scanned: audit.scanned,
    reconciled: 0,
    clearedNegative: 0,
    skipped: 0,
    wouldClearNegative: audit.drifts.filter((d) => d.ledgerSaldo < -1e-9).length,
    errors: [],
    drifts: audit.drifts,
  };

  if (dryRun) return result;

  const products = await db.collection<StockLedgerProduct>('products')
    .find({ tenantId: tid, aktif: { $ne: false } })
    .project({ id: 1, kode: 1, nama: 1, satuan: 1, hargaBeli: 1, gudangKode: 1, tenantId: 1, stok: 1 })
    .toArray();

  for (const product of products) {
    const stokId = String(product.id || '');
    if (!stokId) {
      result.skipped += 1;
      continue;
    }
    try {
      const out = await reconcileProductStockFromLedger(db, tid, product, { clearNegative });
      if ('error' in out) {
        result.errors.push({ productId: stokId, kode: String(product.kode || ''), error: out.error });
        continue;
      }
      if (out.clearedNegative) result.clearedNegative += 1;
      result.reconciled += 1;
    } catch (e) {
      result.errors.push({
        productId: stokId,
        kode: String(product.kode || ''),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}
