// Upsert master produk dari sales.app — katalog global semua tenant vendor.

import { v4 as uuidv4 } from 'uuid';
import { inferGudangKodeFromProduct, setProductWarehouseStock } from '@/lib/api/product-warehouse';

export function vendorProductSnapshot(product) {
  return {
    id: product.id,
    kode: product.kode,
    barcode: product.barcode || '',
    nama: product.nama,
    grup: product.grup || 'Umum',
    satuan: product.satuan || 'PCS',
    aktif: product.aktif !== false,
    vendorTenantId: product.vendorTenantId || product.tenantId || null,
    vendorTenantName: product.vendorTenantName || null,
  };
}

export async function upsertProductFromVendor(db, customerTenantId, vendorTenantId, product) {
  const tid = customerTenantId || 'default';
  const snap = vendorProductSnapshot(product);
  const vTenant = snap.vendorTenantId || vendorTenantId || null;
  const now = new Date();

  if (!vTenant || !snap.id) {
    throw new Error(`Produk ${snap.kode || '?'} tanpa vendorTenantId/vendorStokId`);
  }

  let existing = await db.collection('products').findOne({
    tenantId: tid,
    vendorTenantId: vTenant,
    vendorStokId: snap.id,
  });
  if (!existing) {
    existing = await db.collection('products').findOne({
      tenantId: tid,
      vendorTenantId: vTenant,
      kode: snap.kode,
    });
  }

  const syncSet = {
    kode: snap.kode,
    barcode: snap.barcode,
    nama: snap.nama,
    grup: snap.grup,
    satuan: snap.satuan,
    aktif: snap.aktif,
    vendorStokId: snap.id,
    vendorTenantId: vTenant,
    vendorTenantName: snap.vendorTenantName || vTenant,
    syncSource: 'sales.app',
    updatedAt: now,
  };

  if (existing) {
    await db.collection('products').updateOne({ id: existing.id }, { $set: syncSet });
    await upsertVendorMap(db, tid, vTenant, existing.id, snap);
    return { action: 'updated', id: existing.id, kode: snap.kode, vendorTenantId: vTenant };
  }

  const gudangKode = inferGudangKodeFromProduct(snap);
  const doc = {
    id: uuidv4(),
    tenantId: tid,
    ...syncSet,
    gudangKode,
    hargaBeli: 0,
    hargaSpesial: 0,
    hargaGrosir: 0,
    hargaEcer: 0,
    stok: 0,
    minStok: 0,
    createdAt: now,
  };
  await db.collection('products').insertOne(doc);
  await setProductWarehouseStock(db, tid, doc.id, gudangKode, 0);
  await upsertVendorMap(db, tid, vTenant, doc.id, snap);
  return { action: 'created', id: doc.id, kode: snap.kode, vendorTenantId: vTenant };
}

async function upsertVendorMap(db, tenantId, vendorTenantId, localStokId, snap) {
  const filter = {
    tenantId,
    vendorTenantId: vendorTenantId || null,
    vendorStokId: snap.id,
  };
  const now = new Date();
  await db.collection('vendor_product_map').updateOne(filter, {
    $set: {
      vendorKode: snap.kode,
      localStokId,
      localKode: snap.kode,
      localNama: snap.nama,
      aktif: true,
      updatedAt: now,
    },
    $setOnInsert: { id: uuidv4(), ...filter, createdAt: now },
  }, { upsert: true });
}

export async function deactivateProductFromVendor(db, customerTenantId, product) {
  const tid = customerTenantId || 'default';
  const vTenant = product?.vendorTenantId || product?.tenantId;
  const filter = { tenantId: tid, syncSource: 'sales.app' };
  if (product?.id) filter.vendorStokId = product.id;
  else if (product?.kode && vTenant) {
    filter.kode = product.kode;
    filter.vendorTenantId = vTenant;
  } else return null;

  const r = await db.collection('products').updateOne(
    filter,
    { $set: { aktif: false, updatedAt: new Date() } },
  );
  return r.modifiedCount ? { kode: product.kode, action: 'deactivated' } : null;
}

export function isVendorSyncedProduct(doc) {
  return doc?.syncSource === 'sales.app';
}
