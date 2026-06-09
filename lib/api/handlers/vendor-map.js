import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { requireAuth } from '@/lib/api/require-auth';
import { tenantIdForWrite, withTenantFilter } from '@/lib/api/tenant-master';

export async function handleVendorMap({ db, route, method, path, body, url, auth }) {
  if (route === '/vendor-product-map' && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const list = await db.collection('vendor_product_map').find(withTenantFilter(auth, {})).sort({ updatedAt: -1 }).limit(500).toArray();
    return ok(list.map(clean));
  }

  if (route === '/vendor-product-map' && method === 'POST') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    if (!body?.vendorKode || !body?.localStokId) return err('vendorKode dan localStokId wajib');
    const tenantId = tenantIdForWrite(auth, body);
    const prod = await db.collection('products').findOne({ id: body.localStokId, tenantId });
    if (!prod) return err('Produk lokal tidak ditemukan', 404);

    const filter = { tenantId, vendorTenantId: body.vendorTenantId || null, vendorKode: body.vendorKode };
    const now = new Date();
    const doc = {
      id: uuidv4(), ...filter, vendorStokId: body.vendorStokId || null,
      localStokId: prod.id, localKode: prod.kode, localNama: prod.nama,
      aktif: true, updatedAt: now, createdAt: now,
    };
    await db.collection('vendor_product_map').updateOne(filter, { $set: doc }, { upsert: true });

    const grns = await db.collection('goods_receipts').find({ tenantId, status: 'NEEDS_MAPPING', 'items.vendorKode': body.vendorKode }).toArray();
    for (const grn of grns) {
      const newItems = (grn.items || []).map((it) => it.vendorKode !== body.vendorKode ? it : {
        ...it, localStokId: prod.id, localKode: prod.kode, localNama: prod.nama, mapStatus: 'MAPPED',
      });
      const stillNeeds = newItems.some((it) => !it.localStokId);
      await db.collection('goods_receipts').updateOne({ id: grn.id }, { $set: { items: newItems, status: stillNeeds ? 'NEEDS_MAPPING' : 'DRAFT' } });
    }
    return ok(clean(doc));
  }

  if (path[0] === 'vendor-product-map' && path.length === 2 && method === 'DELETE') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    await db.collection('vendor_product_map').deleteOne(withTenantFilter(auth, { id: path[1] }));
    return ok({ message: 'deleted' });
  }
  return null;
}
