/**
 * Angka dashboard pengadaan — stok gudang, belanja, ringkasan GRN.
 * Harga stok: moving-average hargaBeli, fallback vendorHargaBeli (katalog sync).
 */

import { toHarga, toQty } from '@/lib/api/inventory-cost';
import { WAREHOUSE_CODES } from '@/lib/api/warehouses';

export const DASHBOARD_SNAPSHOT_VERSION = 2;

export const APPROVED_SPENDING_STATUSES = [
  'APPROVED',
  'PAID_EXTERNAL',
  'OUTSTANDING',
  'PARTIAL',
  'LUNAS',
] as const;

/** Invoice yang masuk KPI belanja & grafik 6 bulan — harus sama. */
export function approvedVendorInvoiceMatch(): Record<string, unknown> {
  const statuses = [...APPROVED_SPENDING_STATUSES];
  return {
    $or: [
      { approvalStatus: { $in: statuses } },
      { status: { $in: statuses }, approvalStatus: { $exists: false } },
    ],
  };
}

export function resolveDashboardUnitCost(product: {
  hargaBeli?: unknown;
  vendorHargaBeli?: unknown;
}): number {
  const beli = toHarga(product.hargaBeli);
  if (beli > 0) return beli;
  return Math.max(0, toHarga(product.vendorHargaBeli));
}

export interface InventoryStockRow {
  lokasiKode: string;
  stokId: string;
  qty: number;
}

export interface InventoryWarehouseAgg {
  _id: string;
  qty: number;
  nilai: number;
  skuCount: number;
}

export function foldInventoryByWarehouse(
  rows: InventoryStockRow[],
  priceByStokId: Map<string, number>,
  warehouseCodes: readonly string[] = WAREHOUSE_CODES,
): InventoryWarehouseAgg[] {
  const invMap: Record<string, { qty: number; nilai: number; skuCount: number }> = {};
  for (const row of rows) {
    const kode = String(row.lokasiKode || 'GKERING');
    const qty = toQty(row.qty);
    const harga = priceByStokId.get(String(row.stokId || '')) || 0;
    const cur = invMap[kode] || { qty: 0, nilai: 0, skuCount: 0 };
    cur.qty += qty;
    if (qty !== 0) {
      cur.nilai += qty * harga;
      cur.skuCount += 1;
    }
    invMap[kode] = cur;
  }

  return warehouseCodes.map((kode) => ({
    _id: kode,
    qty: invMap[kode]?.qty || 0,
    nilai: Math.round(invMap[kode]?.nilai || 0),
    skuCount: invMap[kode]?.skuCount || 0,
  }));
}

export interface GrnStatusAggRow {
  _id?: string;
  count?: number;
}

export function grnSummaryFromAgg(rows: GrnStatusAggRow[]) {
  const map = Object.fromEntries(rows.map((r) => [r._id || 'UNKNOWN', r.count || 0]));
  const excluded = (map.CANCELLED || 0) + (map.VOID || 0);
  const total = rows.reduce((s, r) => s + (r.count || 0), 0) - excluded;
  return {
    grn: Math.max(0, total),
    draft: map.DRAFT || 0,
    unknownProduct: (map.UNKNOWN_PRODUCT || 0) + (map.NEEDS_MAPPING || 0),
  };
}

export interface MonthAggRow {
  _id: string;
  total?: number;
  count?: number;
}

export interface SpendingMonth {
  month: string;
  label: string;
  total: number;
  count: number;
}

export function monthLabel(ym: string): string {
  const [y, m] = String(ym).split('-');
  const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
  return d.toLocaleDateString('id-ID', { month: 'short', year: '2-digit' });
}

export function buildSpendingMonths(now: Date, aggRows: MonthAggRow[]): SpendingMonth[] {
  const map = Object.fromEntries(aggRows.map((r) => [r._id, r]));
  const months: SpendingMonth[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const row = map[key];
    months.push({
      month: key,
      label: monthLabel(key),
      total: row?.total || 0,
      count: row?.count || 0,
    });
  }
  return months;
}
