// Upsert master produk dari sales.app — nama, satuan, kode selalu sama.

import { v4 as uuidv4 } from 'uuid';
import { ensureStokLokasiRow } from '@/lib/api/stok-lokasi';

const SYNC_FIELDS = ['kode', 'barcode', 'nama', 'grup', 'satuan', 'vendorStokId', 'vendorTenantId', 'syncSource', 'aktif'];

export function vendorProductSnapshot(product) {
  return {
    id: product.id,
    kode: product.kode,
    barcode: product.barcode || '',
    nama: product.nama,
    grup: product.grup || 'Umum',
    satuan: product.satuan || 'PCS',
    aktif: product.aktif !== false,
  };
}

export async function upsertProductFromVendor(db, customerTenantId, vendorTenantId, product) {
  const tid = customerTenantId || 'default';
  const snap = vendorProductSnapshot(product);
  const now = new Date();

  let existing = await db.collection('products').findOne({ tenantId: tid, kode: snap.kode });
  if (!existing && snap.id) {
    existing = await db.collection('products').findOne({ tenantId: tid, vendorStokId: snap.id });
  }

  const syncSet = {
    ...snap,
    vendorStokId: snap.id,
    vendorTenantId: vendorTenantId || null,
    syncSource: 'sales.app',
    updatedAt: now,
  };
  delete syncSet.id;

  if (existing) {
    await db.collection('products').updateOne({ id: existing.id }, { $set: syncSet });
    await upsertVendorMap(db, tid, vendorTenantId, existing.id, snap);
    return { action: 'updated', id: existing.id, kode: snap.kode };
  }

  const doc = {
    id: uuidv4(),
    tenantId: tid,
    ...syncSet,
    hargaBeli: 0,
    hargaSpesial: 0,
    hargaGrosir: 0,
    hargaEcer: 0,
    stok: 0,
    minStok: 0,
    createdAt: now,
  };
  await db.collection('products').insertOne(doc);
  await ensureStokLokasiRow(db, tid, doc.id, 'L001');
  await upsertVendorMap(db, tid, vendorTenantId, doc.id, snap);
  return { action: 'created', id: doc.id, kode: snap.kode };
}

async function upsertVendorMap(db, tenantId, vendorTenantId, localStokId, snap) {
  const filter = { tenantId, vendorKode: snap.kode, vendorTenantId: vendorTenantId || null };
  const now = new Date();
  await db.collection('vendor_product_map').updateOne(filter, {
    $set: {
      vendorStokId: snap.id,
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
  const kode = product?.kode;
  if (!kode) return null;
  const r = await db.collection('products').updateOne(
    { tenantId: tid, kode, syncSource: 'sales.app' },
    { $set: { aktif: false, updatedAt: new Date() } },
  );
  return r.modifiedCount ? { kode, action: 'deactivated' } : null;
}

export function isVendorSyncedProduct(doc) {
  return doc?.syncSource === 'sales.app';
}
