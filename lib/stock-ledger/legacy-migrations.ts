// Migrasi satu kali dari skema stok lama (products.stok → stok_lokasi, lokasi L001/L002 → gudang).

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { hasSystemFlag, setSystemFlag } from '@/lib/api/system-meta';
import { LEGACY_LOKASI_MAP, normalizeWarehouseKode } from '@/lib/api/warehouses';
import { ensureStokLokasiIndexes } from '@/lib/api/stok-lokasi';
import { roundStockQty } from '@/lib/stock-ledger/precision';
import { STOK_LOKASI } from '@/lib/stock-ledger/balance';

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
  const existing = await db.collection<StokLokasiDoc>(STOK_LOKASI)
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
      await db.collection(STOK_LOKASI).updateOne(
        { tenantId: tid, stokId: p.id, lokasiKode: gudang },
        { $setOnInsert: { id: uuidv4(), qty: roundStockQty(p.stok), updatedAt: new Date() } },
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

/** Pindahkan stok legacy L001/L002 ke gudang baru (sekali per tenant). */
export async function migrateLegacyStokLokasi(db: Db, tenantId: string | null | undefined): Promise<void> {
  const tid = tenantId || 'default';
  const col = db.collection<StokLokasiDoc>(STOK_LOKASI);
  for (const [legacy, target] of Object.entries(LEGACY_LOKASI_MAP)) {
    const legacyRows = await col.find({ tenantId: tid, lokasiKode: legacy }).toArray();
    for (const row of legacyRows) {
      const targetRow = await col.findOne({ tenantId: tid, stokId: row.stokId, lokasiKode: target });
      const qty = roundStockQty(row.qty);
      if (targetRow) {
        await col.updateOne(
          { tenantId: tid, stokId: row.stokId, lokasiKode: target },
          [{ $set: { qty: { $round: [{ $add: [{ $ifNull: ['$qty', 0] }, qty] }, 4] }, updatedAt: new Date() } }],
        );
      } else if (qty > 0) {
        await col.insertOne({
          id: uuidv4(),
          tenantId: tid,
          stokId: row.stokId,
          lokasiKode: target,
          qty,
          updatedAt: new Date(),
        });
      }
      await col.deleteOne({ tenantId: tid, stokId: row.stokId, lokasiKode: legacy });
    }
  }
}
