import type { Db } from 'mongodb';
// Products handler: master CRUD + code/barcode lookup (scoped per tenant).

import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  withTenantFilter,
  tenantIdForWrite,
  findMasterDoc,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { assertMasterAccess } from '@/lib/api/tenant-validate';
import { buildProductSearchFilter, mergeProductSearchWithVendorName, PRODUCT_LIST_PROJECTION } from '@/lib/api/product-query';
import { bulkDeleteMaster } from '@/lib/api/bulk-delete-master';
import { getStokByWarehouseBatch, syncProductStokFromLokasi, getQtyStokLokasi } from '@/lib/api/stok-lokasi';
import { WAREHOUSE_CODES } from '@/lib/api/warehouses';
import {
  isValidProductGudang,
  resolveProductGudangKode,
  setProductWarehouseStock,
  inferGudangKodeFromProduct,
} from '@/lib/api/product-warehouse';
import { isVendorSyncedProduct } from '@/lib/api/product-sync';
import { enrichProductsVendorNames } from '@/lib/api/vendor-tenants';
import { requireRole, PRODUCT_MANAGE_ROLES, STOCK_ADJUST_ROLES } from '@/lib/api/require-auth';
import { recordMasterProductStockChange } from '@/lib/api/stock-ledger';
import { refreshGrnsForProductKode } from '@/lib/api/grn-resolve-products';
import { parseCursorPageParams, applyAscStringIdCursor, encodeStringCursor, sliceCursorPage } from '@/lib/api/cursor-page';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { warehouseLabel } from '@/lib/api/warehouses';
import {
  validateAndNormalizeUomInputs,
  resolveUomInputsFromProductBody,
  pickBaseUom,
} from '@/lib/uom/conversion';
import {
  insertProductUoms,
  planProductUomDocs,
  replaceProductUoms,
  deleteProductUoms,
  listProductUoms,
  listProductUomsByProductIds,
  findProductUomByBarcode,
  prepareProductUomsForWrite,
  productDenormFromBaseUom,
  attachUomSummary,
  uomSummaryForList,
  mergeProductSearchWithUomBarcode,
} from '@/lib/api/product-uom';
import { formatStockDualLabel } from '@/lib/uom/display';
import { assertMultiUomAllowed } from '@/lib/api/feature-flags';
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';
import { isItemRole, normalizeItemRole, type ItemRole } from '@/lib/food-production/item-role';

const VENDOR_LOCKED_FIELDS = [
  'kode', 'nama', 'satuan', 'grup', 'barcode', 'syncSource', 'vendorStokId', 'vendorTenantId', 'baseUomId',
];

const VENDOR_PRICE_FIELDS = ['hargaEcer', 'hargaGrosir', 'hargaSpesial'];

interface ProductBody extends Record<string, unknown> {
  kode?: string;
  nama?: string;
  barcode?: string;
  grup?: string;
  satuan?: string;
  baseUomId?: string;
  uoms?: unknown[];
  gudangKode?: string;
  hargaBeli?: number | string;
  hargaSpesial?: number | string;
  hargaGrosir?: number | string;
  hargaEcer?: number | string;
  stok?: number | string;
  minStok?: number | string;
  aktif?: boolean;
  stokAlasan?: string;
  ids?: unknown[];
  itemRole?: string;
  /**
   * Faktor resep dapur → basis kemasan: 1 products.satuan = N gram.
   * Dipakai Food Production (GR→SAK/BTL), bukan pengadaan integer UOM.
   */
  recipeBaseGrams?: number | string | null;
  /** 1 products.satuan = N ml (konversi resep ML→BTL/dll). */
  recipeBaseMl?: number | string | null;
}

interface ProductDoc extends Record<string, unknown> {
  id: string;
  tenantId?: string;
  kode: string;
  nama: string;
  grup?: string;
  satuan?: string;
  gudangKode?: string;
  stok?: number;
  itemRole?: ItemRole;
  recipeBaseGrams?: number;
  recipeBaseMl?: number;
}

/** Optional positive factor for recipe kitchen UOM; null clears; undefined skips. */
function parseRecipeBaseFactor(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

async function enrichProductList(
  db: Db,
  tenantId: string,
  rows: ProductDoc[],
  includeUomDetail: boolean,
  enrichUom = false,
) {
  if (!rows.length) return rows;
  const uomMap = enrichUom || includeUomDetail
    ? await listProductUomsByProductIds(db, tenantId, rows.map((r) => r.id))
    : new Map<string, import('@/lib/uom/types').ProductUom[]>();
  return rows.map((row) => {
    const uoms = uomMap.get(row.id) || [];
    const stokNum = parseFloat(String(row.stok)) || 0;
    const summary = {
      ...row,
      uomCount: enrichUom || includeUomDetail ? (uoms.length || 1) : (Number(row.uomCount) || 1),
      baseUomId: row.baseUomId || (enrichUom || includeUomDetail ? pickBaseUom(uoms)?.id : undefined),
      stokDisplay: enrichUom || includeUomDetail
        ? formatStockDualLabel(stokNum, uoms)
        : (String(row.stokDisplay || '') || `${stokNum} ${row.satuan || 'PCS'}`),
    };
    if (includeUomDetail && uoms.length) {
      return { ...summary, uoms: uomSummaryForList(uoms) };
    }
    return summary;
  });
}

async function loadProductWithUoms(db: Db, tenantId: string, product: Record<string, unknown>) {
  const uoms = await listProductUoms(db, tenantId, String(product.id));
  return attachUomSummary(product, uoms);
}

export async function handleProducts({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const productBody = (body || {}) as ProductBody;

  if (route === '/products' && method === 'GET') {
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth || !tenantId) return err('Scope tidak valid', 400);

    const q = (url.searchParams.get('q') || '').trim();
    const grup = url.searchParams.get('grup') || '';
    const itemRoleParam = (url.searchParams.get('itemRole') || '').trim();
    const syncSource = (url.searchParams.get('syncSource') || '').trim();
    const idsParam = (url.searchParams.get('ids') || '').trim();
    const skip = Math.max(parseInt(url.searchParams.get('skip') || '0', 10) || 0, 0);
    let filter: Record<string, unknown> = buildProductSearchFilter(q);
    if (grup) filter.grup = grup;
    if (itemRoleParam) {
      if (!isItemRole(itemRoleParam)) {
        return err('itemRole filter tidak valid', 400);
      }
      filter.itemRole = itemRoleParam;
    }
    if (syncSource) {
      // `local` = master inventori (bukan SKU katalog vendor). Include dokumen
      // tanpa field syncSource (data lama), bukan hanya string persis "local".
      if (syncSource === 'local') {
        filter.syncSource = { $ne: 'sales.app' };
      } else {
        filter.syncSource = syncSource;
        if (syncSource === 'sales.app') filter.aktif = { $ne: false };
      }
    }
    if (idsParam) {
      const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length) filter.id = { $in: ids };
    }
    filter = withTenantFilter(scopeAuth, filter);
    filter = await mergeProductSearchWithUomBarcode(db, tenantId, q, filter);
    filter = await mergeProductSearchWithVendorName(db, tenantId, q, filter);

    const { pageMode, limit: pageLimit, cursor } = parseCursorPageParams(url.searchParams, { defaultLimit: 100, maxLimit: 500 });
    const fetchLimit = pageMode ? pageLimit + 1 : pageLimit;
    let listFilter = pageMode ? applyAscStringIdCursor(filter, cursor, 'nama') : filter;

    const list = await db.collection('products')
      .find(listFilter)
      .project(PRODUCT_LIST_PROJECTION)
      .sort({ nama: 1, id: 1 })
      .skip(pageMode ? 0 : skip)
      .limit(pageMode ? fetchLimit : pageLimit)
      .toArray();
    const tid = tenantId;
    const enriched = await enrichProductsVendorNames(db, tid, list) as ProductDoc[];
    const includeUom = url.searchParams.get('includeUom') === '1';
    const enrichUom = url.searchParams.get('enrichUom') === '1';
    const withUom = await enrichProductList(db, tid, enriched, includeUom, enrichUom);
    const withWarehouseStock = url.searchParams.get('withWarehouseStock') === '1';
    if (withWarehouseStock && enriched.length > 0) {
      const stokMap = await getStokByWarehouseBatch(db, tid, withUom.map((p) => p.id));
      for (const p of withUom) {
        const byWh = stokMap.get(p.id) || Object.fromEntries(WAREHOUSE_CODES.map((k) => [k, 0]));
        (p as ProductDoc & { stokByWarehouse?: Record<string, number> }).stokByWarehouse = byWh;
      }
    }
    const cleaned = withUom.map(clean);

    if (pageMode) {
      const { items, hasMore } = sliceCursorPage(cleaned, pageLimit);
      const last = list[Math.min(list.length, pageLimit) - 1] as Record<string, unknown> | undefined;
      return ok({
        items,
        hasMore,
        nextCursor: hasMore && last ? encodeStringCursor(last, 'nama') : null,
      });
    }
    return ok(cleaned);
  }

  if (route === '/products' && method === 'POST') {
    const deniedRole = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: productBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    if (!productBody.kode || !productBody.nama) return err('Kode dan nama wajib');

    const tenantId = tenantIdForWrite(scopeAuth, productBody);
    const grup = String(productBody.grup || 'Umum').trim();

    const uomParsed = validateAndNormalizeUomInputs(resolveUomInputsFromProductBody(productBody));
    if ('error' in uomParsed) return err(uomParsed.error, 400);
    const multiUomDenied = await assertMultiUomAllowed(db, tenantId, uomParsed.uoms.length);
    if (multiUomDenied) return err(multiUomDenied, 403);
    const uomPrep = await prepareProductUomsForWrite(db, tenantId, grup, uomParsed.uoms);
    if ('error' in uomPrep) return err(uomPrep.error, 400);

    const existing = await db.collection('products').findOne({
      tenantId,
      kode: productBody.kode,
      syncSource: 'local',
    });
    if (existing) return err('Kode sudah ada di tenant ini');

    const draft = { grup, nama: productBody.nama };
    const gudangKode = isValidProductGudang(productBody.gudangKode)
      ? String(productBody.gudangKode).trim().toUpperCase()
      : inferGudangKodeFromProduct(draft);
    if (!isValidProductGudang(gudangKode)) {
      return err('Pilih gudang produk: GKERING (Kering), GBASAH (Basah), atau GJANITOR (Janitor)', 400);
    }

    const productId = uuidv4();
    const uomDocs = planProductUomDocs(tenantId, productId, uomParsed.uoms);
    const baseUom = pickBaseUom(uomDocs);
    if (!baseUom) return err('Satuan dasar tidak ditemukan', 500);
    const denorm = productDenormFromBaseUom(baseUom);

    if (productBody.itemRole !== undefined && !isItemRole(productBody.itemRole)) {
      return err('itemRole tidak valid (INGREDIENT|SEMI_FINISHED|FINISHED_GOOD|PACKAGING|CONSUMABLE)', 400);
    }
    const itemRole = normalizeItemRole(productBody.itemRole, 'INGREDIENT');

    const doc: ProductDoc = {
      id: productId,
      tenantId,
      kode: productBody.kode,
      nama: productBody.nama,
      grup,
      gudangKode,
      itemRole,
      ...denorm,
      uomCount: uomDocs.length,
      stokDisplay: formatStockDualLabel(parseFloat(String(productBody.stok || 0)), uomDocs),
      hargaBeli: parseInt(String(productBody.hargaBeli || 0), 10),
      stok: parseFloat(String(productBody.stok || 0)),
      minStok: parseFloat(String(productBody.minStok || 0)),
      aktif: productBody.aktif !== false,
      syncSource: 'local',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const recipeGrams = parseRecipeBaseFactor(productBody.recipeBaseGrams);
    const recipeMl = parseRecipeBaseFactor(productBody.recipeBaseMl);
    if (recipeGrams != null) doc.recipeBaseGrams = recipeGrams;
    if (recipeMl != null) doc.recipeBaseMl = recipeMl;
    const initialStok = doc.stok || 0;
    try {
      await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        await txDb.collection('products').insertOne(doc, txOpts(session));
        await insertProductUoms(txDb, tenantId, productId, uomParsed.uoms, session);
        const wh = await setProductWarehouseStock(txDb, tenantId, doc.id, gudangKode, initialStok, session);
        if ('error' in wh) throw new Error(wh.error);
        if (initialStok > 0) {
          const lokasiLabel = `${gudangKode} - ${warehouseLabel(gudangKode)}`;
          await txDb.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
            id: uuidv4(),
            stokId: doc.id,
            lokasi: lokasiLabel,
            lokasiKode: gudangKode,
            tanggal: new Date(),
            noTransaksi: `INIT-${doc.kode}`,
            keterangan: 'Stok awal produk baru',
            sourceType: 'MASTER_PRODUK',
            masuk: initialStok,
            keluar: 0,
            hargaSatuan: doc.hargaBeli || 0,
          }), txOpts(session));
        }
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Gagal menyimpan produk';
      return err(msg, 500);
    }
    await refreshGrnsForProductKode(db, tenantId, doc.kode);
    await invalidateDashboardSnapshot(db, tenantId);
    const saved = await loadProductWithUoms(
      db,
      tenantId,
      ((await db.collection('products').findOne({ id: doc.id, tenantId })) || doc) as unknown as Record<string, unknown>,
    );
    return ok(clean(saved));
  }

  if (route === '/products/bulk-delete' && method === 'POST') {
    const deniedRole = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: productBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const unique = [...new Set((productBody.ids || []).map(String).filter(Boolean))];
    const tenantId = scopeAuth.tenantId || 'default';
    if (unique.length) {
      const rows = await db.collection('products').find({ tenantId, id: { $in: unique } }).toArray();
      const vendorLocked = rows.filter((r) => isVendorSyncedProduct(r));
      if (vendorLocked.length) {
        return err(`${vendorLocked.length} produk dari sales.app tidak bisa dihapus di inventory`, 400);
      }
      await deleteProductUoms(db, tenantId, unique);
    }
    return bulkDeleteMaster(db, scopeAuth, 'products', productBody.ids);
  }

  if (route === '/products/lookup' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const code = (url.searchParams.get('code') || '').trim();
    if (!code) return err('code required');
    const tenantId = scopeAuth.tenantId || 'default';

    const uomHit = await findProductUomByBarcode(db, tenantId, code);
    if (uomHit) {
      const product = await findMasterDoc(db, 'products', scopeAuth, { id: uomHit.productId });
      if (!product) return err('Produk tidak ditemukan', 404);
      const uoms = (await listProductUomsByProductIds(db, tenantId, [uomHit.productId])).get(uomHit.productId) || [];
      const enriched = attachUomSummary(product as Record<string, unknown>, uoms);
      const matchedUom = uoms.find((u) => u.barcode === code) || uomHit;
      return ok(clean({
        product: enriched,
        uom: matchedUom,
        resolvedBy: 'barcode',
      }));
    }

    let doc = await findMasterDoc(db, 'products', scopeAuth, { barcode: code });
    if (!doc) doc = await findMasterDoc(db, 'products', scopeAuth, { kode: code });
    if (!doc) return err('Produk tidak ditemukan', 404);
    const uoms = (await listProductUomsByProductIds(db, tenantId, [String(doc.id)])).get(String(doc.id)) || [];
    const enriched = attachUomSummary(doc as Record<string, unknown>, uoms);
    const baseUom = pickBaseUom(uoms);
    if (baseUom) {
      return ok(clean({
        product: enriched,
        uom: baseUom,
        resolvedBy: doc.kode === code ? 'kode' : 'base',
      }));
    }
    return ok(clean(enriched));
  }

  if (route === '/products/uom' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = String(scopeAuth.tenantId || 'default');
    const ids = (url.searchParams.get('ids') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
    if (!ids.length) return err('ids wajib');
    const map = await listProductUomsByProductIds(db, tenantId, ids);
    const out: Record<string, unknown[]> = {};
    for (const id of ids) out[id] = (map.get(id) || []).map((u) => clean(u as unknown as Record<string, unknown>));
    return ok(out);
  }

  if (path[0] === 'products' && path.length === 3 && path[2] === 'uom' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const id = path[1];
    const access = await assertMasterAccess(db, scopeAuth, 'products', { id });
    if ('error' in access) return access.error;
    const tenantId = String(access.doc?.tenantId || scopeAuth.tenantId || 'default');
    const uoms = await listProductUoms(db, tenantId, id);
    return ok(uoms.map((u) => clean(u as unknown as Record<string, unknown>)));
  }

  if (path[0] === 'products' && path.length === 2) {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: productBody, request });
    if (denied) return denied;
    if (!scopeAuth || !auth) return err('Scope tidak valid', 400);

    const id = path[1];
    const access = await assertMasterAccess(db, scopeAuth, 'products', { id });
    if (method === 'GET') {
      if ('error' in access) return access.error;
      const tenantId = String(access.doc?.tenantId || scopeAuth.tenantId || 'default');
      const enriched = await loadProductWithUoms(db, tenantId, access.doc as Record<string, unknown>);
      return ok(clean(enriched));
    }
    if (method === 'PUT') {
      if ('error' in access) return access.error;
      const existing = access.doc as ProductDoc;
      const userAuth = auth as AuthContext;
      const isGudang = userAuth.role === 'GUDANG' && !userAuth.isMaster;
      if (isGudang) {
        return err('Role GUDANG tidak boleh mengubah master produk', 403);
      }
      const canAdjustStock = userAuth.isMaster || STOCK_ADJUST_ROLES.includes(userAuth.role);
      if (!canAdjustStock && (productBody.stok !== undefined || productBody.minStok !== undefined)) {
        return err('Hanya Supervisor/Admin yang boleh mengubah stok produk', 403);
      }
      if (isVendorSyncedProduct(existing)) {
        for (const k of VENDOR_LOCKED_FIELDS) {
          if (productBody[k] !== undefined && productBody[k] !== existing[k]) {
            return err(`Field ${k} dikelola sales.app — edit di vendor`, 400);
          }
        }
        if (Array.isArray(productBody.uoms) && productBody.uoms.length > 0) {
          return err('Satuan dikelola sales.app — edit di vendor', 400);
        }
        for (const k of VENDOR_PRICE_FIELDS) {
          if (productBody[k] !== undefined && productBody[k] !== existing[k]) {
            return err(`Field ${k} dikelola sales.app — edit di vendor`, 400);
          }
        }
      }
      const update: Record<string, unknown> = { ...productBody, updatedAt: new Date() };
      delete update.id;
      delete update._id;
      delete update.tenantId;
      delete update.uoms;
      VENDOR_LOCKED_FIELDS.forEach((k) => delete update[k]);
      if (isVendorSyncedProduct(existing)) {
        VENDOR_PRICE_FIELDS.forEach((k) => delete update[k]);
      }
      if (update.kode && update.kode !== existing.kode) {
        const dup = await db.collection('products').findOne({
          tenantId: existing.tenantId || 'default',
          kode: update.kode,
          id: { $ne: id },
        });
        if (dup) return err('Kode sudah ada di tenant ini');
      }
      ['hargaBeli', 'hargaSpesial', 'hargaGrosir', 'hargaEcer'].forEach((k) => {
        if (update[k] !== undefined) update[k] = parseInt(String(update[k] || 0), 10);
      });
      ['stok', 'minStok'].forEach((k) => {
        if (update[k] !== undefined) update[k] = parseFloat(String(update[k] || 0));
      });
      if (productBody.recipeBaseGrams !== undefined) {
        update.recipeBaseGrams = parseRecipeBaseFactor(productBody.recipeBaseGrams) ?? null;
      }
      if (productBody.recipeBaseMl !== undefined) {
        update.recipeBaseMl = parseRecipeBaseFactor(productBody.recipeBaseMl) ?? null;
      }

      const tid = existing.tenantId || 'default';
      const grup = String(update.grup ?? existing.grup ?? 'Umum').trim();
      let uomToWrite: import('@/lib/uom/types').NormalizedUomInput[] | null = null;

      if (!isVendorSyncedProduct(existing)) {
        if (Array.isArray(productBody.uoms) && productBody.uoms.length > 0) {
          const uomParsed = validateAndNormalizeUomInputs(productBody.uoms as import('@/lib/uom/types').UomInput[]);
          if ('error' in uomParsed) return err(uomParsed.error, 400);
          const multiUomDenied = await assertMultiUomAllowed(db, tid, uomParsed.uoms.length);
          if (multiUomDenied) return err(multiUomDenied, 403);
          const uomPrep = await prepareProductUomsForWrite(db, tid, grup, uomParsed.uoms, id);
          if ('error' in uomPrep) return err(uomPrep.error, 400);
          uomToWrite = uomParsed.uoms;
          const uomDocs = planProductUomDocs(tid, id, uomParsed.uoms);
          const baseUom = pickBaseUom(uomDocs);
          if (!baseUom) return err('Satuan dasar tidak ditemukan', 500);
          Object.assign(update, productDenormFromBaseUom(baseUom));
          update.uomCount = uomDocs.length;
          update.stokDisplay = formatStockDualLabel(
            parseFloat(String(update.stok ?? existing.stok ?? 0)),
            uomDocs,
          );
          update.grup = grup;
        } else if (update.grup !== undefined || update.satuan !== undefined) {
          const uomParsed = validateAndNormalizeUomInputs(resolveUomInputsFromProductBody({
            ...existing,
            ...update,
          }));
          if ('error' in uomParsed) return err(uomParsed.error, 400);
          const multiUomDeniedLegacy = await assertMultiUomAllowed(db, tid, uomParsed.uoms.length);
          if (multiUomDeniedLegacy) return err(multiUomDeniedLegacy, 403);
          const uomPrep = await prepareProductUomsForWrite(db, tid, grup, uomParsed.uoms, id);
          if ('error' in uomPrep) return err(uomPrep.error, 400);
          uomToWrite = uomParsed.uoms;
          const uomDocs = planProductUomDocs(tid, id, uomParsed.uoms);
          const baseUom = pickBaseUom(uomDocs);
          if (!baseUom) return err('Satuan dasar tidak ditemukan', 500);
          Object.assign(update, productDenormFromBaseUom(baseUom));
          update.uomCount = uomDocs.length;
          update.stokDisplay = formatStockDualLabel(
            parseFloat(String(update.stok ?? existing.stok ?? 0)),
            uomDocs,
          );
          update.grup = grup;
        }
      }

      if (update.itemRole !== undefined) {
        if (!isItemRole(update.itemRole)) {
          return err('itemRole tidak valid (INGREDIENT|SEMI_FINISHED|FINISHED_GOOD|PACKAGING|CONSUMABLE)', 400);
        }
        update.itemRole = update.itemRole;
      }

      if (update.gudangKode !== undefined) {
        const nextGudang = String(update.gudangKode || '').trim().toUpperCase();
        if (!isValidProductGudang(nextGudang)) {
          return err('Gudang produk tidak valid (GKERING / GBASAH / GJANITOR)', 400);
        }
        if (nextGudang !== resolveProductGudangKode(existing)) {
          const otherRows = await db.collection<{ qty?: number | string }>('stok_lokasi').find({
            tenantId: tid, stokId: id, lokasiKode: { $ne: nextGudang },
          }).toArray();
          const otherQty = otherRows.reduce((s, r) => s + (parseFloat(String(r.qty)) || 0), 0);
          if (otherQty > 0) {
            return err('Tidak bisa pindah gudang — masih ada stok di gudang lama', 400);
          }
        }
        update.gudangKode = nextGudang;
      }
      const stokDiubah = update.stok !== undefined;
      if (stokDiubah) {
        const gudang = resolveProductGudangKode({ ...existing, ...update });
        const qtyAfter = parseFloat(String(update.stok || 0));
        const mergedProduct = { ...existing, ...update, id };
        try {
          await runInTransactionOrFallback(async ({ db: txDb, session }) => {
            if (uomToWrite) {
              await replaceProductUoms(txDb, tid, id, uomToWrite, session);
            }
            const qtyBefore = await getQtyStokLokasi(txDb, tid, id, gudang, session);
            const wh = await setProductWarehouseStock(txDb, tid, id, gudang, qtyAfter, session);
            if ('error' in wh) throw new Error(wh.error);
            await recordMasterProductStockChange(txDb, {
              tenantId: tid,
              product: mergedProduct,
              gudangKode: gudang,
              qtyBefore,
              qtyAfter,
              auth: userAuth,
              reason: productBody.stokAlasan || 'Penyesuaian via edit master produk',
              session,
            });
            update.stok = wh.qty;
            await txDb.collection('products').updateOne(
              withTenantFilter(scopeAuth, { id }),
              { $set: update },
              txOpts(session),
            );
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Gagal menyimpan perubahan stok produk';
          return err(msg, 400);
        }
      } else if (uomToWrite) {
        try {
          await runInTransactionOrFallback(async ({ db: txDb, session }) => {
            await replaceProductUoms(txDb, tid, id, uomToWrite!, session);
            await txDb.collection('products').updateOne(
              withTenantFilter(scopeAuth, { id }),
              { $set: update },
              txOpts(session),
            );
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Gagal menyimpan satuan produk';
          return err(msg, 400);
        }
      } else {
        await db.collection('products').updateOne(
          withTenantFilter(scopeAuth, { id }),
          { $set: update },
        );
      }
      await invalidateDashboardSnapshot(db, tid);
      const doc = await findMasterDoc(db, 'products', auth, { id });
      if (!doc) return ok(clean(doc));
      const enriched = await loadProductWithUoms(db, tid, doc as Record<string, unknown>);
      return ok(clean(enriched));
    }
    if (method === 'DELETE') {
      const denied = requireRole(auth, PRODUCT_MANAGE_ROLES);
      if (denied) return denied;
      if ('error' in access) return access.error;
      if (isVendorSyncedProduct(access.doc)) {
        return err('Produk dari sales.app tidak bisa dihapus di inventory — nonaktifkan di vendor', 400);
      }
      const tid = String(access.doc.tenantId || auth?.tenantId || 'default');
      await deleteProductUoms(db, tid, id);
      await db.collection('products').deleteOne(withTenantFilter(scopeAuth, { id }));
      await invalidateDashboardSnapshot(db, String(access.doc.tenantId || auth?.tenantId || 'default'));
      return ok({ message: 'deleted' });
    }
  }

  return null;
}
