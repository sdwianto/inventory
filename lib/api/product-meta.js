// Master grup & satuan produk per tenant.

import { v4 as uuidv4 } from 'uuid';

export const DEFAULT_PRODUK_GRUP = [
  'Umum',
  'Sembako',
  'Minuman',
  'Makanan Ringan',
  'Toiletries',
  'Roti',
  'Lainnya',
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

export async function ensureProdukMetaForTenant(db, tenantId) {
  const tid = tenantId || 'default';
  const now = new Date();

  const grupCount = await db.collection('produk_grup').countDocuments({ tenantId: tid });
  if (grupCount === 0) {
    await db.collection('produk_grup').insertMany(
      DEFAULT_PRODUK_GRUP.map((nama) => ({
        id: uuidv4(),
        tenantId: tid,
        nama,
        aktif: true,
        createdAt: now,
      })),
    );
  }

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

export async function validateProdukGrupSatuan(db, tenantId, grup, satuan) {
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
