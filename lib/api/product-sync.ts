import type { Db } from 'mongodb';
// Upsert master produk dari sales.app — kode produk sama dengan katalog vendor.

import { v4 as uuidv4 } from 'uuid';
import { inferGudangKodeFromProduct, setProductWarehouseStock } from '@/lib/api/product-warehouse';

function parseVendorPrices(product) {
  return {
    hargaBeli: parseInt(product.hargaBeli || 0, 10),
    hargaGrosir: parseInt(product.hargaGrosir || 0, 10),
    hargaSpesial: parseInt(product.hargaSpesial || 0, 10),
    hargaEcer: parseInt(product.hargaEcer || 0, 10),
  };
}

export function vendorProductSnapshot(product) {
  const prices = parseVendorPrices(product);
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
    ...prices,
  };
}

export async function upsertProductFromVendor(db: Db, customerTenantId, vendorTenantId, product) {
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
      syncSource: 'sales.app',
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
    vendorHargaBeli: snap.hargaBeli,
    vendorHargaGrosir: snap.hargaGrosir,
    vendorHargaSpesial: snap.hargaSpesial,
    vendorHargaEcer: snap.hargaEcer,
    hargaGrosir: snap.hargaGrosir,
    hargaSpesial: snap.hargaSpesial,
    hargaEcer: snap.hargaEcer,
    syncSource: 'sales.app',
    updatedAt: now,
  };

  if (existing) {
    await db.collection('products').updateOne({ id: existing.id }, { $set: syncSet });
    return { action: 'updated', id: existing.id, kode: snap.kode, vendorTenantId: vTenant };
  }

  const gudangKode = inferGudangKodeFromProduct(snap);
  const doc = {
    id: uuidv4(),
    tenantId: tid,
    ...syncSet,
    gudangKode,
    hargaBeli: 0,
    hargaSpesial: snap.hargaSpesial,
    hargaGrosir: snap.hargaGrosir,
    hargaEcer: snap.hargaEcer,
    vendorHargaBeli: snap.hargaBeli,
    vendorHargaGrosir: snap.hargaGrosir,
    vendorHargaSpesial: snap.hargaSpesial,
    vendorHargaEcer: snap.hargaEcer,
    stok: 0,
    minStok: 0,
    createdAt: now,
  };
  await db.collection('products').insertOne(doc);
  await setProductWarehouseStock(db, tid, doc.id, gudangKode, 0);
  return { action: 'created', id: doc.id, kode: snap.kode, vendorTenantId: vTenant };
}

export async function deactivateProductFromVendor(db: Db, customerTenantId, product) {
  const tid = customerTenantId || 'default';
  const vTenant = product?.vendorTenantId || product?.tenantId;
  const filter: Record<string, unknown> = { tenantId: tid, syncSource: 'sales.app' };
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
