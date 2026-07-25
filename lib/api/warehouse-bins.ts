/**
 * W2-16 — Warehouse bin / slot master (addressing metadata).
 * Stock balance stays warehouse-grained (`stok_lokasi`); bins do not change FEFO keys.
 */

import type { Db } from 'mongodb';
import { isValidWarehouseKode, normalizeWarehouseKode } from '@/lib/api/warehouses';

export const WAREHOUSE_BINS_COLLECTION = 'warehouse_bins';

export interface WarehouseBinDoc {
  id: string;
  tenantId: string;
  kode: string;
  warehouseKode: string;
  nama?: string;
  aktif: boolean;
  /** At most one aktif default per (tenantId, warehouseKode). */
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Bin kode: uppercase alphanumeric + hyphen, 1–24 chars. */
export function normalizeBinKode(raw: string | null | undefined): string {
  const s = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 24);
  return s;
}

export function isValidBinKode(raw: string | null | undefined): boolean {
  const k = normalizeBinKode(raw);
  return k.length >= 1 && k.length <= 24;
}

/**
 * Resolve aktif default bin for a warehouse.
 * Returns null when none configured (GRN keeps warehouse-level behavior).
 */
export async function resolveDefaultBinKode(
  db: Db,
  tenantId: string,
  warehouseKode: string | null | undefined,
): Promise<string | null> {
  const wh = normalizeWarehouseKode(warehouseKode);
  if (!isValidWarehouseKode(wh)) return null;
  const tid = tenantId || 'default';
  const row = await db.collection(WAREHOUSE_BINS_COLLECTION).findOne(
    { tenantId: tid, warehouseKode: wh, aktif: true, isDefault: true },
    { projection: { kode: 1 } },
  );
  const kode = normalizeBinKode(row?.kode as string | undefined);
  return kode || null;
}

/** Clear other defaults in the same warehouse before promoting one. */
export async function clearOtherDefaultBins(
  db: Db,
  tenantId: string,
  warehouseKode: string,
  exceptId?: string,
): Promise<void> {
  const tid = tenantId || 'default';
  const wh = normalizeWarehouseKode(warehouseKode);
  const filter: Record<string, unknown> = {
    tenantId: tid,
    warehouseKode: wh,
    isDefault: true,
  };
  if (exceptId) filter.id = { $ne: exceptId };
  await db.collection(WAREHOUSE_BINS_COLLECTION).updateMany(
    filter,
    { $set: { isDefault: false, updatedAt: new Date() } },
  );
}
