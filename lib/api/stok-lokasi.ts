// Baca stok per lokasi (gudang) — qty per tenant + produk + kode lokasi, satuan dasar.
// Semua penulisan stok_lokasi ada di lib/stock-ledger (postStockMovements / master-stock).

import type { ClientSession, Db } from 'mongodb';
import { productFilterById } from '@/lib/api/tenant-operational';
import { normalizeWarehouseKode, WAREHOUSE_CODES } from '@/lib/api/warehouses';
import { txOpts } from '@/lib/api/transaction';

export const DEFAULT_WAREHOUSE = 'GKERING';

let indexesEnsured = false;

interface StokLokasiDoc {
  id?: string;
  tenantId: string;
  stokId: string;
  lokasiKode: string;
  qty?: number | string;
  updatedAt?: Date;
}

function mongoErrorCode(e: unknown): number | undefined {
  return (e as { code?: number })?.code;
}

export function parseLokasiKode(lokasiStr: string | null | undefined): string {
  if (!lokasiStr) return DEFAULT_WAREHOUSE;
  const m = String(lokasiStr).match(/^([A-Za-z0-9]+)/);
  const raw = m ? m[1].toUpperCase() : DEFAULT_WAREHOUSE;
  return normalizeWarehouseKode(raw);
}

export async function ensureStokLokasiIndexes(db: Db): Promise<void> {
  if (indexesEnsured) return;
  try {
    await db.collection('stok_lokasi').createIndex(
      { tenantId: 1, stokId: 1, lokasiKode: 1 },
      { unique: true, name: 'uniq_stok_lokasi' },
    );
  } catch (e: unknown) {
    const code = mongoErrorCode(e);
    if (code !== 85 && code !== 86) console.warn('stok_lokasi index:', (e as Error).message);
  }
  indexesEnsured = true;
}

/** Batch read qty stok per lokasi untuk banyak produk sekaligus. */
export async function getQtyStokLokasiBatch(
  db: Db,
  tenantId: string | null | undefined,
  stokIds: string[],
  lokasiKode: string | null | undefined,
): Promise<Map<string, number | string>> {
  const tid = tenantId || 'default';
  const kode = parseLokasiKode(lokasiKode);
  const ids = [...new Set(stokIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.collection<StokLokasiDoc>('stok_lokasi')
    .find({ tenantId: tid, stokId: { $in: ids }, lokasiKode: kode })
    .project({ stokId: 1, qty: 1 })
    .toArray();
  return new Map(rows.map((r) => [r.stokId, r.qty ?? 0]));
}

export async function getQtyStokLokasi(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
  lokasiKode: string | null | undefined,
  session?: ClientSession,
): Promise<number | string> {
  const row = await db.collection<StokLokasiDoc>('stok_lokasi').findOne({
    tenantId: tenantId || 'default',
    stokId,
    lokasiKode: parseLokasiKode(lokasiKode),
  }, txOpts(session));
  return row?.qty ?? 0;
}

export async function getProductInventorySnapshot(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
) {
  const tid = tenantId || 'default';
  const prod = await db.collection('products').findOne(productFilterById(tid, stokId));
  if (!prod) return null;
  const rows = await db.collection<StokLokasiDoc>('stok_lokasi').find({ tenantId: tid, stokId }).toArray();
  const stokFromLokasi = rows.reduce((s, r) => s + (parseFloat(String(r.qty)) || 0), 0);
  const stok = stokFromLokasi;
  const prodDoc = prod as { hargaBeli?: number | string };
  return {
    stok,
    hargaBeli: parseInt(String(prodDoc.hargaBeli || 0), 10),
    prod,
  };
}

export type WarehouseQtyMap = Record<string, number>;

/** Stok per gudang untuk banyak produk sekaligus. */
export async function getStokByWarehouseBatch(
  db: Db,
  tenantId: string | null | undefined,
  stokIds: string[],
): Promise<Map<string, WarehouseQtyMap>> {
  const tid = tenantId || 'default';
  const ids = [...new Set(stokIds.filter(Boolean))];
  const result = new Map<string, WarehouseQtyMap>(
    ids.map((id) => [id, Object.fromEntries(WAREHOUSE_CODES.map((k) => [k, 0])) as WarehouseQtyMap]),
  );
  if (ids.length === 0) return result;
  const rows = await db.collection<StokLokasiDoc>('stok_lokasi')
    .find({ tenantId: tid, stokId: { $in: ids }, lokasiKode: { $in: [...WAREHOUSE_CODES] } })
    .project({ stokId: 1, lokasiKode: 1, qty: 1 })
    .toArray();
  for (const r of rows) {
    const bucket = result.get(r.stokId);
    if (bucket) bucket[r.lokasiKode] = parseFloat(String(r.qty)) || 0;
  }
  return result;
}
