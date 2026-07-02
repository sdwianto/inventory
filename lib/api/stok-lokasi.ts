// Stok per lokasi (gudang) — qty per tenant + produk + kode lokasi.

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { productFilterById, updateProductStockScoped } from '@/lib/api/tenant-operational';
import { normalizeWarehouseKode, WAREHOUSE_CODES, isValidWarehouseKode } from '@/lib/api/warehouses';
import { assertProductWarehouse, resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { hasSystemFlag, setSystemFlag } from '@/lib/api/system-meta';

export const DEFAULT_WAREHOUSE = 'GKERING';

let indexesEnsured = false;
let stokLokasiMigrated = false;

interface StokLokasiDoc {
  id?: string;
  tenantId: string;
  stokId: string;
  lokasiKode: string;
  qty?: number | string;
  updatedAt?: Date;
}

interface ProductStokSeed {
  id: string;
  tenantId?: string;
  stok?: number | string;
  gudangKode?: string;
  grup?: string;
  nama?: string;
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

export async function migrateStokLokasiFromProducts(db: Db): Promise<number> {
  if (stokLokasiMigrated) return 0;
  if (await hasSystemFlag(db, 'stok_lokasi_migrated')) {
    stokLokasiMigrated = true;
    return 0;
  }
  await ensureStokLokasiIndexes(db);
  const products = await db.collection<ProductStokSeed>('products')
    .find({})
    .project({ id: 1, tenantId: 1, stok: 1, gudangKode: 1, grup: 1, nama: 1 })
    .toArray();
  if (products.length === 0) {
    await setSystemFlag(db, 'stok_lokasi_migrated');
    stokLokasiMigrated = true;
    return 0;
  }
  const existing = await db.collection<StokLokasiDoc>('stok_lokasi')
    .find({})
    .project({ tenantId: 1, stokId: 1, lokasiKode: 1 })
    .toArray();
  const existingKeys = new Set(
    existing.map((r) => `${r.tenantId || 'default'}:${r.stokId}:${normalizeWarehouseKode(r.lokasiKode)}`),
  );
  let inserted = 0;
  for (const p of products) {
    const tid = p.tenantId || 'default';
    const gudang = resolveProductGudangKode(p);
    const key = `${tid}:${p.id}:${gudang}`;
    if (existingKeys.has(key)) continue;
    try {
      await db.collection('stok_lokasi').updateOne(
        { tenantId: tid, stokId: p.id, lokasiKode: gudang },
        {
          $setOnInsert: {
            id: uuidv4(),
            qty: parseFloat(String(p.stok || 0)),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
      existingKeys.add(key);
      inserted += 1;
    } catch (e: unknown) {
      if (mongoErrorCode(e) !== 11000) throw e;
    }
  }
  await setSystemFlag(db, 'stok_lokasi_migrated');
  stokLokasiMigrated = true;
  return inserted;
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
): Promise<number | string> {
  const row = await db.collection<StokLokasiDoc>('stok_lokasi').findOne({
    tenantId: tenantId || 'default',
    stokId,
    lokasiKode: parseLokasiKode(lokasiKode),
  });
  return row?.qty ?? 0;
}

export async function setQtyStokLokasi(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
  lokasiKode: string | null | undefined,
  qty: number | string,
): Promise<number> {
  const tid = tenantId || 'default';
  const kode = parseLokasiKode(lokasiKode);
  const filter = { tenantId: tid, stokId, lokasiKode: kode };
  const next = parseFloat(String(qty)) || 0;
  const existing = await db.collection('stok_lokasi').findOne(filter);
  if (existing) {
    await db.collection('stok_lokasi').updateOne(filter, { $set: { qty: next, updatedAt: new Date() } });
  } else {
    await db.collection('stok_lokasi').insertOne({
      id: uuidv4(),
      ...filter,
      qty: next,
      updatedAt: new Date(),
    });
  }
  return next;
}

async function loadProductForWarehouse(db: Db, tenantId: string, stokId: string) {
  return db.collection('products').findOne(productFilterById(tenantId || 'default', stokId));
}

export type StokLokasiAdjustResult = { qty: number } | { error: string };

export async function adjustStokLokasi(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
  lokasiKode: string | null | undefined,
  delta: number | string,
): Promise<StokLokasiAdjustResult> {
  const tid = tenantId || 'default';
  const kode = parseLokasiKode(lokasiKode);
  const prod = await loadProductForWarehouse(db, tid, stokId);
  if (prod) {
    const whErr = assertProductWarehouse(prod as Record<string, unknown>, kode);
    if (whErr) return whErr;
  }
  const d = parseFloat(String(delta)) || 0;
  const current = parseFloat(String(await getQtyStokLokasi(db, tid, stokId, kode))) || 0;
  const next = current + d;
  if (next < 0) return { error: `Stok di lokasi ${kode} tidak cukup (sisa: ${current})` };
  await setQtyStokLokasi(db, tid, stokId, kode, next);
  return { qty: next };
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
  const prodDoc = prod as { stok?: number | string; hargaBeli?: number | string };
  const stok = rows.length > 0 ? stokFromLokasi : (parseFloat(String(prodDoc.stok)) || 0);
  return {
    stok,
    hargaBeli: parseInt(String(prodDoc.hargaBeli || 0), 10),
    prod,
  };
}

export async function syncProductStokFromLokasi(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
): Promise<number> {
  const tid = tenantId || 'default';
  const rows = await db.collection<StokLokasiDoc>('stok_lokasi').find({ tenantId: tid, stokId }).toArray();
  const total = rows.reduce((s, r) => s + (parseFloat(String(r.qty)) || 0), 0);
  await updateProductStockScoped(db, tid, stokId, { $set: { stok: total, updatedAt: new Date() } });
  return total;
}

export async function ensureStokLokasiRow(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
  lokasiKode: string = DEFAULT_WAREHOUSE,
) {
  const tid = tenantId || 'default';
  const prod = await db.collection('products').findOne(productFilterById(tid, stokId));
  const kode = parseLokasiKode(prod ? resolveProductGudangKode(prod as Record<string, unknown>) : lokasiKode);
  let row = await db.collection('stok_lokasi').findOne({ tenantId: tid, stokId, lokasiKode: kode }) as StokLokasiDoc | null;
  if (row) return row;
  const prodDoc = prod as { stok?: number | string } | null;
  const qty = parseFloat(String(prodDoc?.stok || 0));
  const newRow: StokLokasiDoc = {
    id: uuidv4(),
    tenantId: tid,
    stokId,
    lokasiKode: kode,
    qty,
    updatedAt: new Date(),
  };
  await db.collection('stok_lokasi').insertOne(newRow);
  return newRow;
}

export type TransferStokResult = { ok: true } | { error: string };

export async function transferStokBetweenLokasi(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
  lokasiAsal: string,
  lokasiTujuan: string,
  qty: number | string,
): Promise<TransferStokResult> {
  const q = parseFloat(String(qty)) || 0;
  if (q <= 0) return { error: 'Qty tidak valid' };
  const asal = parseLokasiKode(lokasiAsal);
  const tujuan = parseLokasiKode(lokasiTujuan);
  if (asal === tujuan) return { error: 'Lokasi asal dan tujuan sama' };
  if (isValidWarehouseKode(asal) && isValidWarehouseKode(tujuan)) {
    return { error: 'Produk tidak bisa dipindah antar Gudang Kering dan Basah — item di kedua gudang berbeda' };
  }
  await ensureStokLokasiRow(db, tenantId, stokId, asal);
  await ensureStokLokasiRow(db, tenantId, stokId, tujuan);
  const out = await adjustStokLokasi(db, tenantId, stokId, asal, -q);
  if ('error' in out) return out;
  const inn = await adjustStokLokasi(db, tenantId, stokId, tujuan, q);
  if ('error' in inn) {
    await adjustStokLokasi(db, tenantId, stokId, asal, q);
    return inn;
  }
  await syncProductStokFromLokasi(db, tenantId, stokId);
  return { ok: true };
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
