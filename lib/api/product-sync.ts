import type { Db } from 'mongodb';
// Upsert master produk dari sales.app — kode produk sama dengan katalog vendor.

import { v4 as uuidv4 } from 'uuid';
import { inferGudangKodeFromProduct, setProductWarehouseStock } from '@/lib/api/product-warehouse';
import { pickBaseUom, uomInputsFromLegacyProductBody, validateAndNormalizeUomInputs } from '@/lib/uom/conversion';
import type { NormalizedUomInput } from '@/lib/uom/types';
import {
  replaceProductUoms,
  replaceProductUomsFromVendor,
  productDenormFromBaseUom,
  bulkReplaceProductUoms,
} from '@/lib/api/product-uom';

function parseVendorPrices(product: Record<string, unknown>) {
  return {
    hargaBeli: parseInt(String(product.hargaBeli || 0), 10),
    hargaGrosir: parseInt(String(product.hargaGrosir || 0), 10),
    hargaSpesial: parseInt(String(product.hargaSpesial || 0), 10),
    hargaEcer: parseInt(String(product.hargaEcer || 0), 10),
  };
}

export function vendorProductSnapshot(product: Record<string, unknown>) {
  const prices = parseVendorPrices(product);
  return {
    id: product.id != null ? String(product.id) : '',
    kode: product.kode != null ? String(product.kode) : '',
    barcode: product.barcode != null ? String(product.barcode) : '',
    nama: product.nama != null ? String(product.nama) : '',
    grup: product.grup != null ? String(product.grup) : 'Umum',
    satuan: product.satuan != null ? String(product.satuan) : 'PCS',
    aktif: product.aktif !== false,
    vendorTenantId: product.vendorTenantId != null ? String(product.vendorTenantId) : (product.tenantId != null ? String(product.tenantId) : null),
    vendorTenantName: product.vendorTenantName != null ? String(product.vendorTenantName) : null,
    ...prices,
  };
}

export async function upsertProductFromVendor(
  db: Db,
  customerTenantId: string,
  vendorTenantId: string | null | undefined,
  product: Record<string, unknown>,
) {
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
    await syncVendorProductUoms(db, tid, existing.id, product, snap);
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
  await syncVendorProductUoms(db, tid, doc.id, product, snap);
  return { action: 'created', id: doc.id, kode: snap.kode, vendorTenantId: vTenant };
}

function vendorUomsToInputs(
  vendorProduct: Record<string, unknown>,
  snap: ReturnType<typeof vendorProductSnapshot>,
): NormalizedUomInput[] | null {
  const vendorUoms = Array.isArray(vendorProduct.uoms) ? vendorProduct.uoms : null;
  if (vendorUoms?.length) {
    return (vendorUoms as Array<Record<string, unknown>>).map((u, i) => ({
      satuan: String(u.satuan || 'PCS').trim().toUpperCase(),
      isBase: u.isBase === true,
      factorToBase: parseInt(String(u.factorToBase ?? (u.isBase ? 1 : 1)), 10) || 1,
      barcode: String(u.barcode || ''),
      sortOrder: parseInt(String(u.sortOrder ?? i), 10) || i,
      hargaEcer: parseInt(String(u.hargaEcer || 0), 10),
      hargaGrosir: parseInt(String(u.hargaGrosir || 0), 10),
      hargaSpesial: parseInt(String(u.hargaSpesial || 0), 10),
      aktif: u.aktif !== false,
      vendorUomId: u.id ? String(u.id) : undefined,
    }));
  }
  const legacyParsed = validateAndNormalizeUomInputs(uomInputsFromLegacyProductBody({
    satuan: snap.satuan,
    barcode: snap.barcode,
    hargaEcer: snap.hargaEcer,
    hargaGrosir: snap.hargaGrosir,
    hargaSpesial: snap.hargaSpesial,
  }));
  if ('error' in legacyParsed) return null;
  return legacyParsed.uoms;
}

export async function bulkSyncVendorProductUoms(
  db: Db,
  tenantId: string,
  items: Array<{
    productId: string;
    raw: Record<string, unknown>;
    snap: ReturnType<typeof vendorProductSnapshot>;
  }>,
) {
  if (!items.length) return;

  const entries: Array<{ productId: string; uoms: NormalizedUomInput[] }> = [];
  for (const item of items) {
    const uoms = vendorUomsToInputs(item.raw, item.snap);
    if (uoms?.length) entries.push({ productId: item.productId, uoms });
  }
  if (!entries.length) return;

  const uomDocsByProduct = await bulkReplaceProductUoms(db, tenantId, entries);
  const bulkOps: { updateOne: { filter: { id: string }; update: { $set: ReturnType<typeof productDenormFromBaseUom> } } }[] = [];
  for (const [productId, docs] of uomDocsByProduct) {
    const base = pickBaseUom(docs);
    if (base) {
      bulkOps.push({
        updateOne: {
          filter: { id: productId },
          update: { $set: productDenormFromBaseUom(base) },
        },
      });
    }
  }
  if (bulkOps.length) {
    await db.collection('products').bulkWrite(bulkOps, { ordered: false });
  }
}

export async function syncVendorProductUoms(
  db: Db,
  tenantId: string,
  localProductId: string,
  vendorProduct: Record<string, unknown>,
  snap: ReturnType<typeof vendorProductSnapshot>,
) {
  const vendorUoms = Array.isArray(vendorProduct.uoms) ? vendorProduct.uoms : null;
  let uomDocs;
  if (vendorUoms?.length) {
    uomDocs = await replaceProductUomsFromVendor(db, tenantId, localProductId, vendorUoms as Array<Record<string, unknown>>);
  } else {
    const legacyParsed = validateAndNormalizeUomInputs(uomInputsFromLegacyProductBody({
      satuan: snap.satuan,
      barcode: snap.barcode,
      hargaEcer: snap.hargaEcer,
      hargaGrosir: snap.hargaGrosir,
      hargaSpesial: snap.hargaSpesial,
    }));
    if ('error' in legacyParsed) return;
    uomDocs = await replaceProductUoms(db, tenantId, localProductId, legacyParsed.uoms);
  }
  const base = pickBaseUom(uomDocs);
  if (base) {
    await db.collection('products').updateOne(
      { id: localProductId },
      { $set: productDenormFromBaseUom(base) },
    );
  }
}

export async function deactivateProductFromVendor(
  db: Db,
  customerTenantId: string,
  product: Record<string, unknown>,
) {
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

export function isVendorSyncedProduct(doc: Record<string, unknown> | null | undefined) {
  return doc?.syncSource === 'sales.app';
}
