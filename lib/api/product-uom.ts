import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import {
  PRODUCT_UOM_COLLECTION,
  type NormalizedUomInput,
  type ProductUom,
} from '@/lib/uom/types';
import { pickBaseUom } from '@/lib/uom/conversion';
import { formatStockDualLabel } from '@/lib/uom/display';
import { validateProdukGrupSatuan } from '@/lib/api/product-meta';

let indexesEnsured = false;

export async function ensureProductUomIndexes(db: Db): Promise<void> {
  if (indexesEnsured) return;
  const coll = db.collection(PRODUCT_UOM_COLLECTION);
  try {
    await coll.createIndex(
      { tenantId: 1, productId: 1, satuan: 1 },
      { unique: true, name: 'uniq_product_uom_tenant_product_satuan' },
    );
    await coll.createIndex(
      { tenantId: 1, productId: 1 },
      { name: 'idx_product_uom_tenant_product' },
    );
    await coll.createIndex(
      { tenantId: 1, barcode: 1 },
      {
        unique: true,
        name: 'uniq_product_uom_tenant_barcode',
        partialFilterExpression: { barcode: { $type: 'string', $gt: '' } },
      },
    );
  } catch (e: unknown) {
    const code = (e as { code?: number })?.code;
    if (code !== 85 && code !== 86) console.warn('product_uom index:', (e as Error).message);
  }
  indexesEnsured = true;
}

export async function validateUomSatuanMaster(
  db: Db,
  tenantId: string,
  uoms: NormalizedUomInput[],
  grup: string,
): Promise<{ ok?: true; error?: string }> {
  for (const u of uoms) {
    const check = await validateProdukGrupSatuan(db, tenantId, grup, u.satuan);
    if ('error' in check && check.error) return { error: check.error };
  }
  return { ok: true };
}

async function assertBarcodesUnique(
  db: Db,
  tenantId: string,
  uoms: NormalizedUomInput[],
  excludeProductId?: string,
): Promise<string | null> {
  const codes = uoms.map((u) => u.barcode).filter(Boolean);
  if (!codes.length) return null;

  const dupInPayload = new Set<string>();
  for (const c of codes) {
    if (dupInPayload.has(c)) return `Barcode "${c}" duplikat dalam payload`;
    dupInPayload.add(c);
  }

  for (const code of codes) {
    const uomHit = await db.collection(PRODUCT_UOM_COLLECTION).findOne({
      tenantId,
      barcode: code,
      ...(excludeProductId ? { productId: { $ne: excludeProductId } } : {}),
    });
    if (uomHit) return `Barcode "${code}" sudah dipakai produk lain`;

    const prodHit = await db.collection('products').findOne({
      tenantId,
      barcode: code,
      ...(excludeProductId ? { id: { $ne: excludeProductId } } : {}),
    });
    if (prodHit) return `Barcode "${code}" sudah dipakai produk lain`;
  }
  return null;
}

function buildUomDoc(
  tenantId: string,
  productId: string,
  input: NormalizedUomInput,
  now: Date,
): ProductUom {
  return {
    id: uuidv4(),
    tenantId,
    productId,
    satuan: input.satuan,
    isBase: input.isBase,
    factorToBase: input.factorToBase,
    barcode: input.barcode || '',
    sortOrder: input.sortOrder,
    hargaEcer: input.hargaEcer,
    hargaGrosir: input.hargaGrosir,
    hargaSpesial: input.hargaSpesial,
    aktif: input.aktif,
    ...(input.vendorUomId ? { vendorUomId: input.vendorUomId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export function productDenormFromBaseUom(
  base: ProductUom,
): Pick<ProductUom, 'satuan' | 'barcode' | 'hargaEcer' | 'hargaGrosir' | 'hargaSpesial'> & { baseUomId: string } {
  return {
    baseUomId: base.id,
    satuan: base.satuan,
    barcode: base.barcode || '',
    hargaEcer: base.hargaEcer,
    hargaGrosir: base.hargaGrosir,
    hargaSpesial: base.hargaSpesial,
  };
}

export async function insertProductUoms(
  db: Db,
  tenantId: string,
  productId: string,
  uoms: NormalizedUomInput[],
): Promise<ProductUom[]> {
  await ensureProductUomIndexes(db);
  const now = new Date();
  const docs = uoms.map((u) => buildUomDoc(tenantId, productId, u, now));
  if (docs.length) {
    await db.collection(PRODUCT_UOM_COLLECTION).insertMany(docs, { ordered: true });
  }
  return docs;
}

export async function replaceProductUoms(
  db: Db,
  tenantId: string,
  productId: string,
  uoms: NormalizedUomInput[],
): Promise<ProductUom[]> {
  await ensureProductUomIndexes(db);
  await db.collection(PRODUCT_UOM_COLLECTION).deleteMany({ tenantId, productId });
  return insertProductUoms(db, tenantId, productId, uoms);
}

export async function replaceProductUomsFromVendor(
  db: Db,
  tenantId: string,
  productId: string,
  vendorUoms: Array<Record<string, unknown>>,
): Promise<ProductUom[]> {
  const inputs: NormalizedUomInput[] = vendorUoms.map((u, i) => ({
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
  return replaceProductUoms(db, tenantId, productId, inputs);
}

export async function deleteProductUoms(
  db: Db,
  tenantId: string,
  productId: string | string[],
): Promise<void> {
  const ids = Array.isArray(productId) ? productId : [productId];
  if (!ids.length) return;
  await db.collection(PRODUCT_UOM_COLLECTION).deleteMany({
    tenantId,
    productId: { $in: ids },
  });
}

export async function listProductUoms(
  db: Db,
  tenantId: string,
  productId: string,
): Promise<ProductUom[]> {
  const rows = await db.collection(PRODUCT_UOM_COLLECTION)
    .find({ tenantId, productId, aktif: { $ne: false } })
    .sort({ sortOrder: 1, satuan: 1 })
    .toArray();
  return rows as unknown as ProductUom[];
}

export async function listProductUomsByProductIds(
  db: Db,
  tenantId: string,
  productIds: string[],
): Promise<Map<string, ProductUom[]>> {
  const map = new Map<string, ProductUom[]>();
  if (!productIds.length) return map;
  const rows = await db.collection(PRODUCT_UOM_COLLECTION)
    .find({ tenantId, productId: { $in: productIds }, aktif: { $ne: false } })
    .sort({ sortOrder: 1, satuan: 1 })
    .toArray() as unknown as ProductUom[];
  for (const row of rows) {
    const list = map.get(row.productId) || [];
    list.push(row);
    map.set(row.productId, list);
  }
  return map;
}

export async function findProductUomByBarcode(
  db: Db,
  tenantId: string,
  barcode: string,
): Promise<ProductUom | null> {
  const code = String(barcode || '').trim();
  if (!code) return null;
  const row = await db.collection(PRODUCT_UOM_COLLECTION).findOne({
    tenantId,
    barcode: code,
    aktif: { $ne: false },
  });
  return row as ProductUom | null;
}

export async function findProductUomById(
  db: Db,
  tenantId: string,
  uomId: string,
): Promise<ProductUom | null> {
  const row = await db.collection(PRODUCT_UOM_COLLECTION).findOne({
    tenantId,
    id: uomId,
    aktif: { $ne: false },
  });
  return row as ProductUom | null;
}

export async function findProductUomsByIds(
  db: Db,
  tenantId: string,
  uomIds: string[],
): Promise<Map<string, ProductUom>> {
  const map = new Map<string, ProductUom>();
  const ids = [...new Set(uomIds.filter(Boolean))];
  if (!ids.length) return map;
  const rows = await db.collection(PRODUCT_UOM_COLLECTION)
    .find({ tenantId, id: { $in: ids }, aktif: { $ne: false } })
    .toArray() as unknown as ProductUom[];
  for (const row of rows) map.set(row.id, row);
  return map;
}

const BULK_UOM_INSERT_CHUNK = 500;

/** Ganti UOM banyak produk sekaligus — satu deleteMany + insertMany chunked. */
export async function bulkReplaceProductUoms(
  db: Db,
  tenantId: string,
  entries: Array<{ productId: string; uoms: NormalizedUomInput[] }>,
): Promise<Map<string, ProductUom[]>> {
  const byProduct = new Map<string, ProductUom[]>();
  if (!entries.length) return byProduct;

  await ensureProductUomIndexes(db);
  const productIds = entries.map((e) => e.productId);
  await db.collection(PRODUCT_UOM_COLLECTION).deleteMany({
    tenantId,
    productId: { $in: productIds },
  });

  const now = new Date();
  const allDocs: ProductUom[] = [];
  for (const { productId, uoms } of entries) {
    const docs = uoms.map((u) => buildUomDoc(tenantId, productId, u, now));
    byProduct.set(productId, docs);
    allDocs.push(...docs);
  }

  if (allDocs.length) {
    for (let i = 0; i < allDocs.length; i += BULK_UOM_INSERT_CHUNK) {
      await db.collection(PRODUCT_UOM_COLLECTION).insertMany(
        allDocs.slice(i, i + BULK_UOM_INSERT_CHUNK),
        { ordered: false },
      );
    }
  }

  return byProduct;
}

export function attachUomSummary<T extends Record<string, unknown>>(
  product: T,
  uoms: ProductUom[],
): T & { baseUomId?: string; uomCount: number; uoms: ProductUom[]; stokDisplay: string } {
  const base = pickBaseUom(uoms);
  const stok = parseFloat(String(product.stok)) || 0;
  return {
    ...product,
    baseUomId: (product.baseUomId as string) || base?.id,
    uomCount: uoms.length || 1,
    uoms,
    stokDisplay: formatStockDualLabel(stok, uoms),
  };
}

/** Persist denormalized stokDisplay on product doc after stock/UOM changes. */
export async function persistStokDisplay(
  db: Db,
  tenantId: string,
  productId: string,
  qtyBase?: number,
  session?: import('mongodb').ClientSession,
): Promise<void> {
  const opts = session ? { session } : undefined;
  const prod = await db.collection('products').findOne(
    { tenantId, id: productId },
    opts,
  ) as Record<string, unknown> | null;
  if (!prod) return;
  const stok = qtyBase ?? (parseFloat(String(prod.stok)) || 0);
  const uomCount = Number(prod.uomCount) || 0;
  let stokDisplay: string;
  if (uomCount <= 1) {
    const rounded = Math.round(stok * 1000) / 1000;
    const qtyStr = Number.isInteger(rounded) ? String(rounded) : String(rounded);
    stokDisplay = `${qtyStr} ${String(prod.satuan || 'PCS')}`;
  } else {
    const uoms = await listProductUoms(db, tenantId, productId);
    stokDisplay = formatStockDualLabel(stok, uoms);
  }
  if (String(prod.stokDisplay || '') === stokDisplay) return;
  await db.collection('products').updateOne(
    { tenantId, id: productId },
    { $set: { stokDisplay, updatedAt: new Date() } },
    opts,
  );
}

export async function prepareProductUomsForWrite(
  db: Db,
  tenantId: string,
  grup: string,
  uoms: NormalizedUomInput[],
  excludeProductId?: string,
): Promise<{ ok: true } | { error: string }> {
  const meta = await validateUomSatuanMaster(db, tenantId, uoms, grup);
  if (meta.error) return { error: meta.error };
  const barcodeErr = await assertBarcodesUnique(db, tenantId, uoms, excludeProductId);
  if (barcodeErr) return { error: barcodeErr };
  return { ok: true };
}

export function uomSummaryForList(uoms: ProductUom[]) {
  return uoms.map((u) => ({
    id: u.id,
    satuan: u.satuan,
    isBase: u.isBase,
    factorToBase: u.factorToBase,
    barcode: u.barcode || '',
    hargaEcer: u.hargaEcer,
    hargaGrosir: u.hargaGrosir,
    hargaSpesial: u.hargaSpesial,
    vendorUomId: u.vendorUomId,
  }));
}

/** Tambahkan pencarian barcode satuan alternatif ke filter list produk. */
export async function mergeProductSearchWithUomBarcode(
  db: Db,
  tenantId: string,
  q: string | undefined | null,
  filter: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const term = (q || '').trim();
  if (!term || !/^[A-Za-z0-9\-_.]+$/.test(term) || term.length > 48) return filter;
  const uomHit = await findProductUomByBarcode(db, tenantId, term);
  if (!uomHit) return filter;
  const idClause = { id: uomHit.productId };
  const existingOr = Array.isArray(filter.$or) ? [...filter.$or] : [];
  return { ...filter, $or: [...existingOr, idClause] };
}
