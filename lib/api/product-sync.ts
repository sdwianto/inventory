import type { Db } from 'mongodb';
// Upsert master produk dari sales.app — kode produk sama dengan katalog vendor.

import { v4 as uuidv4 } from 'uuid';
import { setProductWarehouseStock } from '@/lib/api/product-warehouse';
import { applyInferredClassification, inferredClassificationPatch } from '@/lib/api/apply-product-classification';
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
  const recipeGrams = parseVendorRecipeFactor(product.recipeBaseGrams);
  const recipeMl = parseVendorRecipeFactor(product.recipeBaseMl);
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
    // Identitas Master Product lintas tenant — sales.app satu-satunya sumber kebenaran, selalu
    // dikirim (termasuk null saat unlink), jadi di sini selalu di-mirror apa adanya, tanpa guard.
    masterProductId: product.masterProductId != null ? String(product.masterProductId) : null,
    recipeBaseGrams: recipeGrams,
    recipeBaseMl: recipeMl,
    hasRecipeBaseGrams: Object.prototype.hasOwnProperty.call(product, 'recipeBaseGrams'),
    hasRecipeBaseMl: Object.prototype.hasOwnProperty.call(product, 'recipeBaseMl'),
    ...prices,
  };
}

function parseVendorRecipeFactor(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Cari produk aktif lain di tenant yang sama dengan barcode identik tapi item vendor berbeda
 * (vendorStokId beda) — indikasi duplikat SKU dari sales.app (lihat catatan di findBarcodeDuplicate).
 */
export async function findBarcodeDuplicate(
  db: Db,
  tenantId: string,
  barcode: string,
  selfVendorStokId: string,
  selfId?: string,
) {
  if (!barcode) return null;
  const filter: Record<string, unknown> = {
    tenantId,
    barcode,
    aktif: { $ne: false },
    vendorStokId: { $ne: selfVendorStokId },
  };
  if (selfId) filter.id = { $ne: selfId };
  return db.collection('products').findOne(filter, { projection: { id: 1, kode: 1, nama: 1, satuan: 1, masterProductId: 1 } });
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

  const barcodeDup = await findBarcodeDuplicate(db, tid, snap.barcode, snap.id, existing?.id ? String(existing.id) : undefined);
  // Kalau kedua produk memang sudah dikonfirmasi Master Product yang sama (identitas resmi dari
  // sales.app), barcode kembar itu wajar (barang sama dari vendor berbeda) — bukan anomali data.
  const confirmedSameMaster = !!snap.masterProductId
    && !!barcodeDup
    && (barcodeDup as { masterProductId?: string | null }).masterProductId === snap.masterProductId;

  const syncSet: Record<string, unknown> = {
    barcodeDuplicateWarning: !!barcodeDup && !confirmedSameMaster,
    barcodeDuplicateOf: barcodeDup?.id ?? null,
    barcodeDuplicateConfirmedSameMaster: confirmedSameMaster,
    kode: snap.kode,
    barcode: snap.barcode,
    nama: snap.nama,
    grup: snap.grup,
    satuan: snap.satuan,
    aktif: snap.aktif,
    vendorStokId: snap.id,
    vendorTenantId: vTenant,
    vendorTenantName: snap.vendorTenantName || vTenant,
    vendorBaseUomId: resolveVendorBaseUomId(product, snap),
    vendorHargaBeli: snap.hargaBeli,
    vendorHargaGrosir: snap.hargaGrosir,
    vendorHargaSpesial: snap.hargaSpesial,
    vendorHargaEcer: snap.hargaEcer,
    hargaGrosir: snap.hargaGrosir,
    hargaSpesial: snap.hargaSpesial,
    hargaEcer: snap.hargaEcer,
    syncSource: 'sales.app',
    masterProductId: snap.masterProductId,
    updatedAt: now,
  };
  if (snap.hasRecipeBaseGrams) syncSet.recipeBaseGrams = snap.recipeBaseGrams;
  if (snap.hasRecipeBaseMl) syncSet.recipeBaseMl = snap.recipeBaseMl;

  if (existing) {
    const classPatch = await applyInferredClassification(db, tid, existing, snap);
    await db.collection('products').updateOne({ id: existing.id }, { $set: { ...syncSet, ...classPatch } });
    await syncVendorProductUoms(db, tid, existing.id, product, snap);
    return {
      action: 'updated',
      id: existing.id,
      kode: snap.kode,
      vendorTenantId: vTenant,
      barcodeDuplicateOf: barcodeDup ? { id: barcodeDup.id, kode: barcodeDup.kode, nama: barcodeDup.nama } : null,
    };
  }

  const classified = inferredClassificationPatch(snap);
  const gudangKode = classified.gudangKode;
  const doc = {
    id: uuidv4(),
    tenantId: tid,
    ...syncSet,
    ...classified,
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
  return {
    action: 'created',
    id: doc.id,
    kode: snap.kode,
    vendorTenantId: vTenant,
    barcodeDuplicateOf: barcodeDup ? { id: barcodeDup.id, kode: barcodeDup.kode, nama: barcodeDup.nama } : null,
  };
}

/** ID satuan dasar di sales.app untuk produk legacy (tanpa baris product_uom). */
export function resolveVendorBaseUomId(
  vendorProduct: Record<string, unknown>,
  snap: ReturnType<typeof vendorProductSnapshot>,
): string {
  const fromCatalog = vendorProduct.baseUomId != null ? String(vendorProduct.baseUomId).trim() : '';
  if (fromCatalog) return fromCatalog;
  const vendorUoms = Array.isArray(vendorProduct.uoms) ? vendorProduct.uoms : [];
  const base = vendorUoms.find((u) => (u as { isBase?: boolean }).isBase === true) || vendorUoms[0];
  if (base && (base as { id?: string }).id) return String((base as { id: string }).id);
  return `legacy:${snap.id}`;
}

function attachLegacyVendorUomIds(
  uoms: NormalizedUomInput[],
  vendorBaseUomId: string,
): NormalizedUomInput[] {
  return uoms.map((u) => ({
    ...u,
    vendorUomId: u.vendorUomId || (u.isBase ? vendorBaseUomId : undefined),
  }));
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
  const vendorBaseUomId = resolveVendorBaseUomId(vendorProduct, snap);
  return attachLegacyVendorUomIds(legacyParsed.uoms, vendorBaseUomId);
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
    const vendorBaseUomId = resolveVendorBaseUomId(vendorProduct, snap);
    uomDocs = await replaceProductUoms(
      db,
      tenantId,
      localProductId,
      attachLegacyVendorUomIds(legacyParsed.uoms, vendorBaseUomId),
    );
  }
  const base = pickBaseUom(uomDocs);
  if (base) {
    const vendorBaseUomId = resolveVendorBaseUomId(vendorProduct, snap);
    await db.collection('products').updateOne(
      { id: localProductId },
      {
        $set: {
          ...productDenormFromBaseUom(base),
          vendorBaseUomId,
        },
      },
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

export function isVendorProductActive(doc: Record<string, unknown> | null | undefined) {
  return doc?.aktif !== false;
}

/** Kunci unik produk vendor di katalog sales: vendorTenantId + vendorStokId. */
export function vendorCatalogKey(vendorTenantId: string, vendorStokId: string): string {
  return `${vendorTenantId}:${vendorStokId}`;
}

export function vendorCatalogKeyFromProduct(product: Record<string, unknown>): string | null {
  const vTenant = String(product.vendorTenantId || product.tenantId || '').trim();
  const vStok = String(product.id || product.vendorStokId || '').trim();
  if (!vTenant || !vStok) return null;
  return vendorCatalogKey(vTenant, vStok);
}

/** Nonaktifkan salinan inventory yang tidak lagi ada di katalog sales aktif. */
export async function reconcileOrphanVendorProducts(
  db: Db,
  customerTenantId: string,
  activeCatalogKeys: Set<string>,
): Promise<{ deactivated: number; sample: string[] }> {
  const tid = customerTenantId || 'default';
  const rows = await db.collection('products').find({
    tenantId: tid,
    syncSource: 'sales.app',
    aktif: { $ne: false },
    vendorStokId: { $exists: true, $type: 'string', $ne: '' },
    vendorTenantId: { $exists: true, $type: 'string', $ne: '' },
  }).project({ id: 1, kode: 1, vendorStokId: 1, vendorTenantId: 1 }).toArray();

  const orphanIds: string[] = [];
  const sample: string[] = [];
  for (const row of rows) {
    const key = vendorCatalogKey(String(row.vendorTenantId), String(row.vendorStokId));
    if (activeCatalogKeys.has(key)) continue;
    orphanIds.push(String(row.id));
    if (sample.length < 10) sample.push(String(row.kode || row.id));
  }

  if (!orphanIds.length) return { deactivated: 0, sample: [] };

  const now = new Date();
  const r = await db.collection('products').updateMany(
    { tenantId: tid, id: { $in: orphanIds } },
    { $set: { aktif: false, updatedAt: now } },
  );
  return { deactivated: r.modifiedCount, sample };
}

/** Perbaiki product_uom yang sudah disync tapi vendorUomId kosong (data lama / sync incremental). */
export async function backfillVendorUomLinks(db: Db, customerTenantId: string) {
  const tid = customerTenantId || 'default';
  const products = await db.collection('products').find({
    tenantId: tid,
    syncSource: 'sales.app',
    vendorStokId: { $exists: true, $ne: '' },
  }).project({ id: 1, vendorStokId: 1 }).toArray();

  if (!products.length) return { fixed: 0 };

  const productIds = products.map((p) => String(p.id));
  const vendorStokByProduct = new Map(products.map((p) => [String(p.id), String(p.vendorStokId)]));

  const broken = await db.collection('product_uom').find({
    tenantId: tid,
    productId: { $in: productIds },
    aktif: { $ne: false },
    $or: [
      { vendorUomId: { $exists: false } },
      { vendorUomId: '' },
      { vendorUomId: null },
    ],
  }).toArray();

  let fixed = 0;
  const now = new Date();
  for (const row of broken) {
    const vendorStokId = vendorStokByProduct.get(String(row.productId));
    if (!vendorStokId) continue;
    const vendorUomId = row.isBase === true ? `legacy:${vendorStokId}` : undefined;
    if (!vendorUomId) continue;
    await db.collection('product_uom').updateOne(
      { id: row.id },
      { $set: { vendorUomId, updatedAt: now } },
    );
    fixed += 1;
  }
  return { fixed };
}
