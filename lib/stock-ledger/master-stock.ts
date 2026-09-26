// Operasi stok dari master produk: inisialisasi baris gudang, edit stok (penyesuaian), pindah gudang,
// dan perbaikan dari kartu. Perubahan qty selalu lewat postStockMovements (jejak kartu di sesi yang sama),
// kecuali perbaikan drift yang justru menyamakan saldo gudang dengan kartu.

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { warehouseLabel, normalizeWarehouseKode, isValidWarehouseKode, WAREHOUSE_CODES, type WarehouseCode } from '@/lib/api/warehouses';
import { resolveProductGudangKode, inferGudangKodeFromProduct, isValidProductGudang } from '@/lib/api/product-warehouse';
import { productFilterById } from '@/lib/api/tenant-operational';
import { getQtyStokLokasi } from '@/lib/api/stok-lokasi';
import { runInTransactionOnDb, txOpts } from '@/lib/api/transaction';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { postMasterAdjustmentJournal } from '@/lib/api/stock-cost-journal';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import type { AuthContext } from '@/types/auth';
import { isZeroQty, roundStockQty, roundUnitCost } from '@/lib/stock-ledger/precision';
import {
  STOK_KARTU,
  STOK_LOKASI,
  purgeNonHomeLokasiRows,
  recomputeProductStok,
  setHomeWarehouseQty,
  type SetWarehouseStockResult,
} from '@/lib/stock-ledger/balance';
import { ledgerSaldoForProducts } from '@/lib/stock-ledger/ledger-saldo';
import { buildKartuDoc, type StockActor, type StockCostSource } from '@/lib/stock-ledger/kartu';
import { isMemoCostItem } from '@/lib/stock-ledger/cost';
import { postStockMovements } from '@/lib/stock-ledger/post-stock-movements';

export type { SetWarehouseStockResult };

export type StockLedgerProduct = Record<string, unknown> & {
  id?: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  hargaBeli?: number | string;
  tenantId?: string;
  gudangKode?: string | null;
};

/**
 * Siapkan baris stok SKU di gudang home dengan qty 0 (produk baru / sinkron katalog) dan rapikan
 * baris gudang lain. Stok non-nol wajib lewat postStockMovements agar selalu ada jejak kartu.
 */
export async function setProductWarehouseStock(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
  gudangKode: string,
  qty: number | string = 0,
  session?: ClientSession,
): Promise<SetWarehouseStockResult> {
  if (roundStockQty(qty) !== 0) {
    return { error: 'Stok awal non-nol wajib diposting lewat buku stok (postStockMovements)' };
  }
  return setHomeWarehouseQty(db, tenantId || 'default', stokId, gudangKode, 0, session);
}

/** Dilempar di dalam transaksi agar kegagalan setelah ada tulisan (mis. OUT sudah terposting) me-rollback semuanya. */
class MasterStockAbort extends Error {}

async function inOwnTransaction<T>(
  db: Db,
  run: (db: Db, session?: ClientSession) => Promise<T>,
  failed: (r: T) => string | null,
): Promise<T | { error: string }> {
  try {
    return await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const r = await run(txDb, session);
      const error = failed(r);
      if (error) throw new MasterStockAbort(error);
      return r;
    });
  } catch (e) {
    if (e instanceof MasterStockAbort) return { error: e.message };
    throw e;
  }
}

function actorFromAuth(auth?: AuthContext | null): StockActor | null {
  return auth ? { userId: auth.userId, userName: auth.name || auth.email, role: auth.role } : null;
}

interface MasterStockChangeParams {
  tenantId: string;
  product: StockLedgerProduct;
  gudangKode: string;
  qtyAfter: number | string;
  auth?: AuthContext | null;
  reason?: string;
  session?: ClientSession;
}

export type MasterStockChangeResult =
  | { ok: true; qty: number; qtyBefore: number; selisih: number; noPenyesuaian?: string }
  | { ok: false; error: string };

/**
 * Edit stok dari master produk = penyesuaian: penyesuaian_stok + posting selisih lewat buku stok
 * (kartu, lot bahan, audit) di sesi yang sama. Baris gudang non-home dirapikan dulu.
 */
export async function applyMasterProductStockChange(
  db: Db,
  params: MasterStockChangeParams,
): Promise<MasterStockChangeResult> {
  if (params.session) return applyMasterStockInSession(db, params);
  const r = await inOwnTransaction(
    db,
    (txDb, session) => applyMasterStockInSession(txDb, { ...params, session }),
    (res) => (res.ok ? null : res.error),
  );
  return 'error' in r && !('ok' in r) ? { ok: false, error: r.error } : r as MasterStockChangeResult;
}

async function applyMasterStockInSession(
  db: Db,
  {
    tenantId,
    product,
    gudangKode,
    qtyAfter,
    auth,
    reason = 'Penyesuaian via edit master produk',
    session,
  }: MasterStockChangeParams,
): Promise<MasterStockChangeResult> {
  const tid = tenantId || 'default';
  const stokId = product?.id != null ? String(product.id) : '';
  if (!stokId) return { ok: false, error: 'Produk tidak valid' };
  const lokasiKode = normalizeWarehouseKode(gudangKode);
  if (!isValidWarehouseKode(lokasiKode)) return { ok: false, error: 'Gudang produk tidak valid' };
  const after = roundStockQty(qtyAfter);
  if (after < 0) return { ok: false, error: 'Stok tidak boleh negatif' };

  await purgeNonHomeLokasiRows(db, tid, stokId, lokasiKode, session);
  const before = roundStockQty(await getQtyStokLokasi(db, tid, stokId, lokasiKode, session));
  const selisih = roundStockQty(after - before);
  if (isZeroQty(selisih)) {
    const qty = await recomputeProductStok(db, tid, stokId, session);
    return { ok: true, qty, qtyBefore: before, selisih: 0 };
  }

  const now = new Date();
  const noPS = await nextDocNumber(db, tid, 'PS', 'PS', session);
  const lokasiLabel = `${lokasiKode} - ${warehouseLabel(lokasiKode)}`;
  const harga = roundUnitCost(product?.hargaBeli);
  const penyesuaianId = uuidv4();

  await db.collection('penyesuaian_stok').insertOne(stampTenantId(tid, {
    id: penyesuaianId,
    noPenyesuaian: noPS,
    tanggal: now,
    lokasi: lokasiLabel,
    lokasiKode,
    keterangan: reason,
    userId: auth?.userId || '',
    userName: auth?.name || auth?.email || '',
    source: 'MASTER_PRODUK',
    items: [{
      stokId,
      kode: product.kode,
      nama: product.nama,
      satuan: product.satuan,
      gudangKode: lokasiKode,
      qtySistem: before,
      qtyAktual: after,
      selisih,
    }],
    createdAt: now,
  }), txOpts(session));

  const posted = await postStockMovements(db, session, {
    tenantId: tid,
    sourceType: 'PENYESUAIAN',
    sourceId: penyesuaianId,
    noTransaksi: noPS,
    keterangan: `${reason} — ${product.kode} ${product.nama}`,
    postingDate: now,
    actor: actorFromAuth(auth),
    lines: [{
      lineRef: stokId,
      productId: stokId,
      warehouseKode: lokasiKode,
      deltaQtyBase: selisih,
      unitCost: harga > 0 ? harga : undefined,
      lokasiLabel,
      satuan: product.satuan,
      kartuExtra: { penyesuaianId },
      lotPolicy: { mode: 'VARIANCE' },
    }],
  });
  if (!posted.ok) return { ok: false, error: posted.error };
  await postMasterAdjustmentJournal(db, session, {
    tenantId: tid,
    sourceId: penyesuaianId,
    noDoc: `${noPS}/${product.kode || stokId}`,
    tanggal: now,
    userName: auth?.name || auth?.email || '',
    line: posted.lines[0],
  });

  await writeAuditLog(db, {
    tenantId: tid,
    action: 'STOCK_ADJUSTMENT',
    entityType: 'penyesuaian_stok',
    entityId: penyesuaianId,
    summary: `${noPS}: ${product.kode} selisih ${selisih}`,
    ...auditActor(auth),
    metadata: { stokId, selisih, lokasiKode, source: 'MASTER_PRODUK' },
  }, session);

  return { ok: true, qty: posted.productStok[stokId] ?? after, qtyBefore: before, selisih, noPenyesuaian: noPS };
}

export type RelocateWarehouseResult =
  | { moved: number; from: WarehouseCode; to: WarehouseCode }
  | { error: string };

interface RelocateParams {
  tenantId: string;
  product: StockLedgerProduct;
  nextGudang: string;
  auth?: AuthContext | null;
  reason?: string;
  session?: ClientSession;
}

/** Pindahkan qty SKU ke gudang baru (satu gudang per SKU) lewat buku stok, atomik. */
export async function relocateProductWarehouseWithAudit(
  db: Db,
  params: RelocateParams,
): Promise<RelocateWarehouseResult> {
  if (!params.session) {
    return inOwnTransaction(
      db,
      (txDb, session) => relocateInSession(txDb, { ...params, session }),
      (res) => ('error' in res ? res.error : null),
    );
  }
  return relocateInSession(db, params);
}

async function relocateInSession(
  db: Db,
  { tenantId, product, nextGudang, auth, reason, session }: RelocateParams,
): Promise<RelocateWarehouseResult> {
  const tid = tenantId || 'default';
  const stokId = product?.id != null ? String(product.id) : '';
  if (!stokId) return { error: 'Produk tidak valid' };
  const toRaw = normalizeWarehouseKode(nextGudang);
  if (!isValidWarehouseKode(toRaw)) return { error: 'Gudang produk tidak valid' };
  const to = toRaw as WarehouseCode;
  const from = resolveProductGudangKode(product);
  if (from === to) return { moved: 0, from, to };

  const qtyFrom = roundStockQty(await getQtyStokLokasi(db, tid, stokId, from, session));
  const note = reason || `Reclassify gudang ${from} → ${to}`;
  const now = new Date();
  const noTransaksi = `RELOC-${String(product.kode || stokId)}-${now.getTime()}`;
  const common = {
    tenantId: tid,
    sourceType: 'RELOKASI_GUDANG',
    sourceId: `${stokId}:${now.getTime()}`,
    noTransaksi,
    postingDate: now,
    actor: actorFromAuth(auth),
    enforceLedger: false,
  } as const;

  if (qtyFrom > 0) {
    const out = await postStockMovements(db, session, {
      ...common,
      keterangan: `${note} (keluar ${warehouseLabel(from)})`,
      lines: [{
        lineRef: 'OUT',
        productId: stokId,
        warehouseKode: from,
        deltaQtyBase: -qtyFrom,
        lokasiLabel: `${from} - ${warehouseLabel(from)}`,
        lotPolicy: { mode: 'RELOCATE', toWarehouseKode: to },
      }],
    });
    if (!out.ok) return { error: out.error };
  }

  await db.collection('products').updateOne(
    productFilterById(tid, stokId),
    { $set: { gudangKode: to, updatedAt: now } },
    txOpts(session),
  );

  if (qtyFrom > 0) {
    const inn = await postStockMovements(db, session, {
      ...common,
      keterangan: `${note} (masuk ${warehouseLabel(to)})`,
      lines: [{
        lineRef: 'IN',
        productId: stokId,
        warehouseKode: to,
        deltaQtyBase: qtyFrom,
        lokasiLabel: `${to} - ${warehouseLabel(to)}`,
      }],
    });
    if (!inn.ok) return { error: inn.error };
  }

  await purgeNonHomeLokasiRows(db, tid, stokId, to, session);
  await recomputeProductStok(db, tid, stokId, session);
  await writeAuditLog(db, {
    tenantId: tid,
    action: 'STOCK_TRANSFER',
    entityType: 'product',
    entityId: stokId,
    summary: `${product.kode || stokId}: pindah gudang ${from} → ${to} (${qtyFrom})`,
    ...auditActor(auth),
    metadata: { from, to, moved: qtyFrom, noTransaksi },
  }, session);

  return { moved: qtyFrom, from, to };
}

/** Samakan stok master & gudang dengan saldo kartu stok (perbaikan data ganda gudang). */
export async function reconcileProductStockFromLedger(
  db: Db,
  tenantId: string,
  product: StockLedgerProduct | null | undefined,
  opts: { clearNegative?: boolean } = {},
): Promise<{ error: string } | { stok: number; gudangKode: string; clearedNegative?: boolean }> {
  return runInTransactionOnDb(db, ({ db: txDb, session }) => reconcileInSession(txDb, tenantId, product, opts, session));
}

async function reconcileInSession(
  db: Db,
  tenantId: string,
  product: StockLedgerProduct | null | undefined,
  opts: { clearNegative?: boolean },
  session?: ClientSession,
): Promise<{ error: string } | { stok: number; gudangKode: string; clearedNegative?: boolean }> {
  const tid = tenantId || product?.tenantId || 'default';
  const stokId = product?.id != null ? String(product.id) : '';
  if (!stokId) return { error: 'Produk tidak valid' };
  const gudang = resolveProductGudangKode(product);
  const infoMap = await ledgerSaldoForProducts(db, tid, [stokId], session);
  const info = infoMap.get(stokId) || { saldo: 0, hasActivity: false };

  // Belum ada jejak kartu: purge phantom WH saja, pertahankan qty gudang home.
  if (!info.hasActivity) {
    const homeQty = Math.max(0, roundStockQty(await getQtyStokLokasi(db, tid, stokId, gudang, session)));
    const result = await setHomeWarehouseQty(db, tid, stokId, gudang, homeQty, session);
    if ('error' in result) return result;
    return { stok: homeQty, gudangKode: gudang };
  }

  let saldo = info.saldo;
  let clearedNegative = false;
  if (saldo < 0 && !isZeroQty(saldo) && opts.clearNegative) {
    const cleared = await clearNegativeLedgerWithAdjustment(db, tid, product, saldo, session);
    if ('error' in cleared) return cleared;
    saldo = 0;
    clearedNegative = true;
  }

  const qty = Math.max(0, roundStockQty(saldo));
  const result = await setHomeWarehouseQty(db, tid, stokId, gudang, qty, session);
  if ('error' in result) return result;
  return { stok: qty, gudangKode: gudang, clearedNegative };
}

async function clearNegativeLedgerWithAdjustment(
  db: Db,
  tenantId: string,
  product: StockLedgerProduct | null | undefined,
  negativeSaldo: number,
  session?: ClientSession,
): Promise<{ ok: true; noPS: string } | { error: string }> {
  const stokId = product?.id != null ? String(product.id) : '';
  if (!stokId || !(negativeSaldo < 0)) return { error: 'Saldo tidak valid untuk koreksi' };
  const tid = tenantId || 'default';
  const need = roundStockQty(-negativeSaldo);
  const now = new Date();
  const noPS = await nextDocNumber(db, tid, 'PS', 'PS', session);
  const gudang = resolveProductGudangKode(product);
  const lokasiLabel = `${gudang} - ${warehouseLabel(gudang)}`;
  const penyesuaianId = uuidv4();
  await db.collection('penyesuaian_stok').insertOne(stampTenantId(tid, {
    id: penyesuaianId,
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
  }), txOpts(session));
  const costingV2 = await isTenantFeatureEnabled(db, tid, 'costingV2');
  const memo = isMemoCostItem({ itemRole: product?.itemRole as string | undefined });
  const avg = roundUnitCost(product?.avgCost as number | string | undefined);
  const fallback = roundUnitCost(product?.hargaBeli);
  let harga = fallback;
  let costSource: StockCostSource = fallback > 0 ? 'PRODUCT_AVG' : 'NONE';
  if (costingV2 && memo) {
    harga = 0;
    costSource = 'NON_INVENTORY';
  } else if (costingV2 && avg > 0) {
    harga = avg;
    costSource = 'AVG';
  }
  await db.collection(STOK_KARTU).insertOne(buildKartuDoc({
    tenantId: tid,
    stokId,
    lokasiKode: gudang,
    lokasiLabel,
    postingDate: now,
    noTransaksi: noPS,
    sourceType: 'PENYESUAIAN',
    sourceId: penyesuaianId,
    lineRef: stokId,
    keterangan: `Penyesuaian Stok (+) ${noPS} — koreksi drift lokasi vs kartu`,
    deltaQtyBase: need,
    unitCost: harga,
    costSource,
    actor: { userId: 'system', userName: 'system-reconcile' },
  }), txOpts(session));
  await postMasterAdjustmentJournal(db, session, {
    tenantId: tid,
    sourceId: penyesuaianId,
    noDoc: `${noPS}/${product?.kode || stokId}`,
    tanggal: now,
    userName: 'system-reconcile',
    line: { deltaQtyBase: need, unitCost: harga, costSource },
  });
  return { ok: true, noPS };
}

/** Tetapkan gudang home tiap produk tenant dan rapikan baris stok_lokasi-nya. */
export async function backfillProductGudangForTenant(db: Db, tenantId: string | null | undefined) {
  const tid = tenantId || 'default';
  const products = await db.collection<{
    id: string;
    gudangKode?: string;
    stok?: number | string;
    grup?: string;
    nama?: string;
  }>('products').find({ tenantId: tid }).toArray();
  let updated = 0;

  for (const prod of products) {
    let gudang: WarehouseCode | null = prod.gudangKode && isValidProductGudang(prod.gudangKode)
      ? (normalizeWarehouseKode(prod.gudangKode) as WarehouseCode)
      : null;

    if (!gudang) {
      const rows = await db.collection<{ lokasiKode: string; qty?: number | string }>(STOK_LOKASI)
        .find({ tenantId: tid, stokId: prod.id, lokasiKode: { $in: [...WAREHOUSE_CODES] } })
        .toArray();
      const withQty = rows.filter((r) => roundStockQty(r.qty) > 0);
      if (withQty.length === 1) {
        gudang = withQty[0].lokasiKode as WarehouseCode;
      } else if (withQty.length > 1) {
        withQty.sort((a, b) => roundStockQty(b.qty) - roundStockQty(a.qty));
        gudang = withQty[0].lokasiKode as WarehouseCode;
      } else {
        gudang = inferGudangKodeFromProduct(prod);
      }
    }

    if (prod.gudangKode !== gudang) {
      await db.collection('products').updateOne(
        productFilterById(tid, prod.id),
        { $set: { gudangKode: gudang, updatedAt: new Date() } },
      );
      updated += 1;
    }

    const row = await db.collection(STOK_LOKASI).findOne({
      tenantId: tid, stokId: prod.id, lokasiKode: gudang,
    }) as { qty?: number | string } | null;
    await setHomeWarehouseQty(db, tid, prod.id, gudang, roundStockQty(row?.qty), undefined);
  }

  return { products: products.length, updated };
}

export async function backfillAllProductGudang(db: Db) {
  const tenantIds = await db.collection('products').distinct('tenantId') as string[];
  const results: Record<string, Awaited<ReturnType<typeof backfillProductGudangForTenant>>> = {};
  for (const tid of tenantIds.filter(Boolean)) {
    results[tid] = await backfillProductGudangForTenant(db, tid);
  }
  return results;
}
