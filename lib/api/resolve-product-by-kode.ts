import type { Db } from 'mongodb';
// Single source of truth: kode produk di master = kode di sales.app.

export async function resolveProductByKode(db: Db, tenantId, vendorTenantId, vendorItem) {
  const tid = tenantId || 'default';
  const kode = String(vendorItem?.kode || '').trim();
  if (!kode) {
    return { localStokId: null, localKode: null, localNama: null };
  }

  let prod = await db.collection('products').findOne({
    tenantId: tid,
    kode,
    aktif: { $ne: false },
  });

  if (!prod && vendorItem?.stokId && vendorTenantId) {
    prod = await db.collection('products').findOne({
      tenantId: tid,
      vendorStokId: vendorItem.stokId,
      vendorTenantId,
      aktif: { $ne: false },
    });
  }

  if (!prod) {
    return { localStokId: null, localKode: null, localNama: null };
  }

  return {
    localStokId: prod.id,
    localKode: prod.kode,
    localNama: prod.nama,
  };
}
