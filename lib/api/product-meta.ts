// Master grup & satuan produk per tenant.

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';

export const DEFAULT_PRODUK_GRUP = [
  'Buah',
  'Lainnya',
  'Makanan Ringan',
  'Minuman',
  'Protein Hewani',
  'Palen',
  'Roti',
  'Sayuran',
  'Sembako',
  'Toiletries',
  'Umum',
];

export const DEFAULT_PRODUK_SATUAN = [
  'PCS',
  'KG',
  'GR',
  'LTR',
  'BOX',
  'PACK',
  'DUS',
  'BTL',
];

export async function ensureProdukMetaForTenant(
  db: Db,
  tenantId: string | null | undefined,
): Promise<void> {
  const tid = tenantId || 'default';
  const now = new Date();

  await seedMetaNames(db, 'produk_grup', tid, DEFAULT_PRODUK_GRUP, now);

  const satuanCount = await db.collection('produk_satuan').countDocuments({ tenantId: tid });
  if (satuanCount === 0) {
    await db.collection('produk_satuan').insertMany(
      DEFAULT_PRODUK_SATUAN.map((nama) => ({
        id: uuidv4(),
        tenantId: tid,
        nama,
        aktif: true,
        createdAt: now,
      })),
    );
  }
}

async function seedMetaNames(
  db: Db,
  collection: string,
  tenantId: string,
  names: string[],
  now: Date,
): Promise<void> {
  for (const nama of names) {
    const existing = await db.collection(collection).findOne({ tenantId, nama });
    if (existing) continue;
    try {
      await db.collection(collection).insertOne({
        id: uuidv4(),
        tenantId,
        nama,
        aktif: true,
        createdAt: now,
      });
    } catch (e: unknown) {
      const code = (e as { code?: number })?.code;
      if (code !== 11000) throw e;
    }
  }
}

export type ProdukMetaValidation =
  | { ok: true }
  | { error: string };

export async function validateProdukGrupSatuan(
  db: Db,
  tenantId: string | null | undefined,
  grup: string,
  satuan: string,
): Promise<ProdukMetaValidation> {
  const tid = tenantId || 'default';
  await ensureProdukMetaForTenant(db, tid);

  const [grupDoc, satuanDoc] = await Promise.all([
    db.collection('produk_grup').findOne({ tenantId: tid, nama: grup, aktif: { $ne: false } }),
    db.collection('produk_satuan').findOne({ tenantId: tid, nama: satuan, aktif: { $ne: false } }),
  ]);

  if (!grupDoc) {
    return { error: `Grup "${grup}" belum terdaftar. Kelola master grup terlebih dahulu.` };
  }
  if (!satuanDoc) {
    return { error: `Satuan "${satuan}" belum terdaftar. Kelola master satuan terlebih dahulu.` };
  }
  return { ok: true };
}
