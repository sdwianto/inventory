// Audit & rekonsiliasi buku stok (read-only + orkestrasi). Penulisan ada di lib/stock-ledger.

import type { Db } from 'mongodb';
import { normalizeWarehouseKode, WAREHOUSE_CODES, type WarehouseCode } from '@/lib/api/warehouses';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import {
  availableQtyAgainstLedger,
  ledgerSaldoForProducts,
  reconcileProductStockFromLedger,
  roundStockQty,
  STOCK_QTY_EPS,
  type LedgerSaldoInfo,
  type StockLedgerProduct,
} from '@/lib/stock-ledger';

export {
  availableQtyAgainstLedger,
  getAvailableQtyAtLokasi,
  ledgerSaldoForProducts,
  shouldEnforceLedgerOnOutbound,
  applyMasterProductStockChange,
  relocateProductWarehouseWithAudit,
  reconcileProductStockFromLedger,
  type LedgerSaldoInfo,
  type RelocateWarehouseResult,
} from '@/lib/stock-ledger';

/** Saldo stok dari seluruh baris kartu stok (sumber kebenaran mutasi). */
export async function ledgerSaldoForProduct(db: Db, tenantId: string, stokId: string): Promise<number> {
  const map = await ledgerSaldoForProducts(db, tenantId || 'default', [stokId]);
  return map.get(stokId)?.saldo ?? 0;
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
    byProd.get(sid)![String(r.lokasiKode)] = roundStockQty(r.qty);
  }

  const drifts: StockDriftRow[] = [];
  for (const product of products) {
    const stokId = String(product.id || '');
    if (!stokId) continue;
    const home = resolveProductGudangKode(product);
    const wh = byProd.get(stokId) || {};
    const lokasiHome = Number(wh[home]) || 0;
    const lokasiTotal = roundStockQty(Object.values(wh).reduce((s, v) => s + (Number(v) || 0), 0));
    const info = ledgerMap.get(stokId) || { saldo: 0, hasActivity: false };
    const masterStok = roundStockQty(product.stok as number | string | undefined);
    const phantomWarehouses = Object.keys(wh).filter(
      (k) => k !== home && Math.abs(Number(wh[k]) || 0) > STOCK_QTY_EPS,
    );
    const issues: string[] = [];
    if (info.hasActivity && Math.abs(lokasiHome - Math.max(0, info.saldo)) > STOCK_QTY_EPS) {
      issues.push(`home_vs_ledger ${lokasiHome}!=${info.saldo}`);
    }
    if (Math.abs(masterStok - lokasiTotal) > STOCK_QTY_EPS) {
      issues.push(`master_vs_lokasi ${masterStok}!=${lokasiTotal}`);
    }
    if (phantomWarehouses.length) {
      issues.push(`phantom_wh ${phantomWarehouses.join(',')}`);
    }
    if (info.hasActivity && info.saldo < -STOCK_QTY_EPS) {
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
  opts: { dryRun?: boolean; clearNegative?: boolean; actor?: { userId: string; userName: string } } = {},
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
    wouldClearNegative: audit.drifts.filter((d) => d.ledgerSaldo < -STOCK_QTY_EPS).length,
    errors: [],
    drifts: audit.drifts,
  };

  if (dryRun) return result;

  const products = await db.collection<StockLedgerProduct>('products')
    .find({ tenantId: tid, aktif: { $ne: false } })
    .project({ id: 1, kode: 1, nama: 1, satuan: 1, hargaBeli: 1, avgCost: 1, itemRole: 1, gudangKode: 1, tenantId: 1, stok: 1 })
    .toArray();

  for (const product of products) {
    const stokId = String(product.id || '');
    if (!stokId) {
      result.skipped += 1;
      continue;
    }
    try {
      const out = await reconcileProductStockFromLedger(db, tid, product, { clearNegative, actor: opts.actor });
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
