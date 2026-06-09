import { v4 as uuidv4 } from 'uuid';

export async function resolveVendorProductMap(db, tenantId, vendorTenantId, vendorItem) {
  const tid = tenantId || 'default';
  const filter = {
    tenantId: tid,
    aktif: { $ne: false },
    $or: [{ vendorStokId: vendorItem.stokId }, { vendorKode: vendorItem.kode }],
  };
  if (vendorTenantId) filter.vendorTenantId = vendorTenantId;

  const map = await db.collection('vendor_product_map').findOne(filter);
  if (map) {
    const prod = map.localStokId
      ? await db.collection('products').findOne({ id: map.localStokId, tenantId: tid })
      : null;
    return { localStokId: map.localStokId, localKode: prod?.kode || map.localKode, localNama: prod?.nama || map.localNama };
  }

  if (vendorItem.kode) {
    const prod = await db.collection('products').findOne({ tenantId: tid, kode: vendorItem.kode, aktif: { $ne: false } });
    if (prod) {
      await db.collection('vendor_product_map').insertOne({
        id: uuidv4(), tenantId: tid, vendorTenantId: vendorTenantId || null,
        vendorStokId: vendorItem.stokId, vendorKode: vendorItem.kode,
        localStokId: prod.id, localKode: prod.kode, localNama: prod.nama,
        aktif: true, autoMatched: true, createdAt: new Date(),
      });
      return { localStokId: prod.id, localKode: prod.kode, localNama: prod.nama };
    }
  }
  return { localStokId: null, localKode: null, localNama: null };
}
