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
import { buildProductSearchFilter, mergeProductSearchWithVendorName, applyProductCatalogFilters, PRODUCT_LIST_PROJECTION } from '@/lib/api/product-query';
import { NOT_DELETED_PRODUCT_FILTER, softDeleteProducts } from '@/lib/api/product-delete';
import { getStokByWarehouseBatch } from '@/lib/api/stok-lokasi';
import { WAREHOUSE_CODES } from '@/lib/api/warehouses';
import {
  isValidProductGudang,
  resolveProductGudangKode,
} from '@/lib/api/product-warehouse';
import { classifyProduct, resolveClassificationSource } from '@/lib/api/product-classification';
import { applyLedgerCapToWarehouseMap } from '@/lib/api/stock-ledger';
import {
  ledgerSaldoForProducts,
  postStockMovements,
  formatMasterStokDisplay,
  recomputeProductStok,
  relocateProductWarehouseWithAudit,
  roundStockQty,
  setProductWarehouseStock,
} from '@/lib/stock-ledger';
import { postMasterAdjustmentJournal } from '@/lib/api/stock-cost-journal';
import { isVendorSyncedProduct } from '@/lib/api/product-sync';
import { NOT_MERGED_PRODUCT_FILTER, isDuplicateKodeError, normalizeBaseSatuan } from '@/lib/api/product-merge';
import { normalizeDetailProduk, persistProductFotos } from '@/lib/api/product-media';
import { drainEnsureProductEnrichment, ensureProductEnrichmentOutboxPending } from '@/lib/api/product-enrichment-outbox';
import { enrichProductsVendorNames } from '@/lib/api/vendor-tenants';
import { requireRole, PRODUCT_MANAGE_ROLES, STOCK_ADJUST_ROLES } from '@/lib/api/require-auth';
import { refreshGrnsForProductKode } from '@/lib/api/grn-resolve-products';
import { parseCursorPageParams, applyAscStringIdCursor, encodeStringCursor, sliceCursorPage } from '@/lib/api/cursor-page';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import {
  validateAndNormalizeUomInputs,
  resolveUomInputsFromProductBody,
  pickBaseUom,
} from '@/lib/uom/conversion';
import {
  insertProductUoms,
  planProductUomDocs,
  replaceProductUoms,
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
import { assertMultiUomAllowed, isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';
import { isItemRole, normalizeItemRole, type ItemRole } from '@/lib/food-production/item-role';
import { normalizeShelfLifeDays } from '@/lib/food-production/ingredient-lot';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import {
  RECIPE_BRIDGE_VALUE_FIELDS,
  manualRecipeBridgeSet,
  resolveRecipeBridgeInput,
  stripRecipeBridgeMeta,
} from '@/lib/api/product-recipe-bridge';

/** Field identitas vendor yang tidak boleh diubah dari Inventory (kecuali `nama` — boleh koreksi lokal). */
const VENDOR_LOCKED_FIELDS = [
  'kode', 'satuan', 'grup', 'barcode', 'syncSource', 'vendorStokId', 'vendorTenantId', 'baseUomId',
  // Identitas Master Product — sales.app satu-satunya sumber kebenaran, admin lokal tidak boleh
  // mengubahnya manual (harus selalu lewat sync ulang dari vendor).
  'masterProductId',
];

const VENDOR_PRICE_FIELDS = ['hargaEcer', 'hargaGrosir', 'hargaSpesial'];

/** Diisi hanya oleh buku stok / proses server; tidak boleh ditulis lewat edit master. */
const PRODUCT_SERVER_OWNED_FIELDS = [
  'stok', 'stokDisplay', 'avgCost', 'avgCostUpdatedAt', 'deletedAt', 'deletedBy', 'kodeAsli',
  'mergedInto', 'mergedAt', 'createdAt', 'uomCount',
];

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
  classificationSource?: string;
  /**
   * Faktor resep dapur → basis kemasan: 1 products.satuan = N gram.
   * Dipakai Food Production (GR→SAK/BTL), bukan pengadaan integer UOM.
   */
  recipeBaseGrams?: number | string | null;
  /** 1 products.satuan = N ml (konversi resep ML→BTL/dll). */
  recipeBaseMl?: number | string | null;
  /** 1 products.satuan = N satuanIsi (mis. 1 RTG = 10 SACHET). */
  isiPerKemasan?: number | string | null;
  satuanIsi?: string | null;
  /** Masa simpan (hari) — dasar kedaluwarsa lot bila GRN tidak mengisi tanggal. */
  shelfLifeDays?: number | string | null;
  /** No. lot pemasok wajib di GRN (flag lotExpiryRequired). */
  requiresLotNo?: boolean;
  detailProduk?: string;
  fotos?: unknown[];
}

function resolveLotControlInput(
  body: ProductBody,
): { values: Record<string, unknown> } | { error: string } {
  const values: Record<string, unknown> = {};
  if (body.shelfLifeDays !== undefined) {
    const shelf = normalizeShelfLifeDays(body.shelfLifeDays);
    if (shelf !== null && typeof shelf === 'object') return { error: shelf.error };
    values.shelfLifeDays = shelf;
  }
  if (body.requiresLotNo !== undefined) {
    if (typeof body.requiresLotNo !== 'boolean') return { error: 'requiresLotNo harus true/false' };
    values.requiresLotNo = body.requiresLotNo;
  }
  return { values };
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
  classificationSource?: 'inferred' | 'manual';
  recipeBaseGrams?: number | null;
  recipeBaseMl?: number | null;
  isiPerKemasan?: number | null;
  satuanIsi?: string | null;
  detailProduk?: string;
  fotos?: string[];
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
    const syncSource = (url.searchParams.get('syncSource') || '').trim();
    const idsParam = (url.searchParams.get('ids') || '').trim();
    const skip = Math.max(parseInt(url.searchParams.get('skip') || '0', 10) || 0, 0);
    let filter: Record<string, unknown> = buildProductSearchFilter(q);
    if (grup) filter.grup = grup;
    const catalog = applyProductCatalogFilters(filter, {
      gudangKode: url.searchParams.get('gudangKode'),
      itemRole: url.searchParams.get('itemRole'),
    });
    if (catalog.error) return err(catalog.error, 400);
    filter = catalog.filter as Record<string, unknown>;
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
    // Salinan vendor tergabung hanya untuk pemilih pembelian (PO) atau lookup id eksplisit.
    const includeVendorSources = url.searchParams.get('includeVendorSources') === '1' || !!idsParam;
    if (!includeVendorSources) Object.assign(filter, NOT_MERGED_PRODUCT_FILTER);
    if (!idsParam) Object.assign(filter, NOT_DELETED_PRODUCT_FILTER);
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
    // Sumber vendor tidak memegang stok: tampilkan stok item persediaan kanoniknya.
    const stockIdOf = (p: ProductDoc) => String((p as { mergedInto?: string }).mergedInto || p.id);
    const canonIds = [...new Set(withUom.map((p) => (p as { mergedInto?: string }).mergedInto).filter(Boolean).map(String))];
    const canonById = new Map(
      canonIds.length
        ? (await db.collection('products').find({ tenantId: tid, id: { $in: canonIds } })
          .project({ id: 1, kode: 1, nama: 1, stok: 1, stokDisplay: 1, gudangKode: 1, itemRole: 1 }).toArray())
          .map((c) => [String(c.id), c])
        : [],
    );
    for (const p of withUom) {
      const c = canonById.get(stockIdOf(p));
      if (!c || c.id === p.id) continue;
      Object.assign(p, {
        stok: c.stok,
        stokDisplay: c.stokDisplay,
        gudangKode: c.gudangKode ?? p.gudangKode,
        mergedIntoKode: c.kode,
        mergedIntoNama: c.nama,
      });
    }
    const withWarehouseStock = url.searchParams.get('withWarehouseStock') === '1' || !!q;
    if (withWarehouseStock && withUom.length > 0) {
      const ids = [...new Set(withUom.map(stockIdOf))];
      const stokMap = await getStokByWarehouseBatch(db, tid, ids);
      const ledgerMap = await ledgerSaldoForProducts(db, tid, ids);
      for (const p of withUom) {
        const sid = stockIdOf(p);
        const raw = stokMap.get(sid) || Object.fromEntries(WAREHOUSE_CODES.map((k) => [k, 0]));
        const home = resolveProductGudangKode(p as Record<string, unknown>);
        const byWh = applyLedgerCapToWarehouseMap(raw, home, ledgerMap.get(sid));
        const whDoc = p as ProductDoc & { stokByWarehouse?: Record<string, number>; gudangKode?: string };
        whDoc.stokByWarehouse = byWh;
        // Tampilan picker: qty gudang home dibatasi saldo kartu (bukan phantom lokasi).
        whDoc.stokGudangQty = Number(byWh[home]) || 0;
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
    const grup = String(productBody.grup || '').trim();
    if (!grup) return err('Pilih grup dari daftar master', 400);

    const uomParsed = validateAndNormalizeUomInputs(resolveUomInputsFromProductBody(productBody));
    if ('error' in uomParsed) return err(uomParsed.error, 400);
    const multiUomDenied = await assertMultiUomAllowed(db, tenantId, uomParsed.uoms.length);
    if (multiUomDenied) return err(multiUomDenied, 403);
    const uomPrep = await prepareProductUomsForWrite(db, tenantId, grup, uomParsed.uoms);
    if ('error' in uomPrep) return err(uomPrep.error, 400);

    // Satu kode = satu item persediaan, termasuk item nonaktif (item sales.app bisa aktif lagi saat vendor menjual ulang).
    const existing = await db.collection('products').findOne({
      tenantId,
      kode: productBody.kode,
      $or: [{ syncSource: 'local' }, NOT_MERGED_PRODUCT_FILTER],
    }, { projection: { nama: 1, aktif: 1 } });
    if (existing) {
      const note = existing.aktif === false ? ' (nonaktif — aktifkan item itu)' : '';
      return err(`Kode sudah dipakai produk ${existing.nama || productBody.kode}${note} di tenant ini`, 409);
    }

    const draft = { grup, nama: productBody.nama };
    const classified = classifyProduct(draft);
    const gudangKode = isValidProductGudang(productBody.gudangKode)
      ? String(productBody.gudangKode).trim().toUpperCase()
      : classified.gudangKode;
    if (!isValidProductGudang(gudangKode)) {
      return err('Pilih gudang produk: GKERING (Kering), GBASAH (Basah), atau GJANITOR (Janitor)', 400);
    }

    const initialStokRaw = productBody.stok === undefined || productBody.stok === null || productBody.stok === ''
      ? 0
      : Number(productBody.stok);
    if (!Number.isFinite(initialStokRaw) || initialStokRaw < 0) {
      return err('Stok awal harus angka ≥ 0', 400);
    }
    const initialStok = roundStockQty(initialStokRaw);
    if (initialStok > 0 && await isTenantFeatureEnabled(db, tenantId, 'adjustmentApproval')) {
      return err('Persetujuan penyesuaian aktif — simpan produk dengan stok 0, lalu isi stok awal lewat Penyesuaian', 400);
    }

    const productId = uuidv4();
    const uomDocs = planProductUomDocs(tenantId, productId, uomParsed.uoms);
    const baseUom = pickBaseUom(uomDocs);
    if (!baseUom) return err('Satuan dasar tidak ditemukan', 500);
    const denorm = productDenormFromBaseUom(baseUom);

    if (productBody.itemRole !== undefined && !isItemRole(productBody.itemRole)) {
      return err('itemRole tidak valid (INGREDIENT|SEMI_FINISHED|FINISHED_GOOD|PACKAGING|CONSUMABLE)', 400);
    }
    const itemRole = productBody.itemRole !== undefined
      ? normalizeItemRole(productBody.itemRole, 'INGREDIENT')
      : classified.itemRole;
    const classificationSource = productBody.classificationSource === 'inferred'
      ? 'inferred'
      : resolveClassificationSource({ itemRole, gudangKode, inferred: classified });

    const doc: ProductDoc = {
      id: productId,
      tenantId,
      kode: productBody.kode,
      nama: productBody.nama,
      grup,
      gudangKode,
      itemRole,
      classificationSource,
      ...denorm,
      uomCount: uomDocs.length,
      stokDisplay: formatMasterStokDisplay(0, tenantId, productId, denorm, uomDocs),
      hargaBeli: parseInt(String(productBody.hargaBeli || 0), 10),
      stok: 0,
      minStok: parseFloat(String(productBody.minStok || 0)),
      aktif: productBody.aktif !== false,
      syncSource: 'local',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const bridge = resolveRecipeBridgeInput(productBody, doc.satuan, null);
    if ('error' in bridge) return err(bridge.error, 400);
    if (bridge.changed) Object.assign(doc, manualRecipeBridgeSet(bridge.values, doc.createdAt as Date));
    const lotControl = resolveLotControlInput(productBody);
    if ('error' in lotControl) return err(lotControl.error, 400);
    Object.assign(doc, lotControl.values);
    if (productBody.detailProduk !== undefined) {
      const detail = normalizeDetailProduk(productBody.detailProduk);
      if (typeof detail === 'object' && 'error' in detail) return err(detail.error, 400);
      doc.detailProduk = detail;
    }
    if (productBody.fotos !== undefined) {
      const fotos = await persistProductFotos(tenantId, productBody.fotos);
      if (!Array.isArray(fotos)) return err(fotos.error, 400);
      doc.fotos = fotos;
    }
    try {
      await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        await txDb.collection('products').insertOne(doc, txOpts(session));
        await insertProductUoms(txDb, tenantId, productId, uomParsed.uoms, session);
        const wh = await setProductWarehouseStock(txDb, tenantId, doc.id, gudangKode, 0, session);
        if ('error' in wh) throw new Error(wh.error);
        if (initialStok > 0) {
          const posted = await postStockMovements(txDb, session, {
            tenantId,
            sourceType: 'MASTER_PRODUK',
            sourceId: doc.id,
            noTransaksi: `INIT-${doc.kode}`,
            keterangan: 'Stok awal produk baru',
            actor: auth ? { userId: auth.userId, userName: auth.name || auth.email, role: auth.role } : null,
            lines: [{
              lineRef: doc.id,
              productId: doc.id,
              warehouseKode: gudangKode,
              deltaQtyBase: initialStok,
              unitCost: Number(doc.hargaBeli) || 0,
            }],
          });
          if (!posted.ok) throw new Error(posted.error);
          await postMasterAdjustmentJournal(txDb, session, {
            tenantId,
            sourceId: doc.id,
            noDoc: `INIT-${doc.kode}`,
            tanggal: doc.createdAt as Date,
            userName: auth ? auth.name || auth.email : '',
            line: posted.lines[0],
          });
        }
      });
    } catch (e: unknown) {
      if (isDuplicateKodeError(e)) return err('Kode sudah dipakai produk aktif lain di tenant ini', 409);
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
    const tenantId = tenantIdForWrite(scopeAuth, productBody);
    const removed = await softDeleteProducts(db, tenantId, (productBody.ids || []).map(String), auth);
    if (!removed.ok) return err(removed.error, removed.status);
    await invalidateDashboardSnapshot(db, tenantId);
    return ok({ deleted: removed.deleted, requested: (productBody.ids || []).length });
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
      let product = await findMasterDoc(db, 'products', scopeAuth, { id: uomHit.productId });
      if (product?.mergedInto) product = await findMasterDoc(db, 'products', scopeAuth, { id: String(product.mergedInto) }) || product;
      if (!product) return err('Produk tidak ditemukan', 404);
      const pid = String(product.id);
      const uoms = (await listProductUomsByProductIds(db, tenantId, [pid])).get(pid) || [];
      const enriched = attachUomSummary(product as Record<string, unknown>, uoms);
      const matchedUom = uoms.find((u) => u.barcode === code)
        || (pid === uomHit.productId ? uomHit : uoms.find((u) => u.satuan === uomHit.satuan) || pickBaseUom(uoms) || uomHit);
      return ok(clean({
        product: enriched,
        uom: matchedUom,
        resolvedBy: 'barcode',
      }));
    }

    let doc = await findMasterDoc(db, 'products', scopeAuth, { barcode: code, ...NOT_MERGED_PRODUCT_FILTER });
    if (!doc) doc = await findMasterDoc(db, 'products', scopeAuth, { kode: code, ...NOT_MERGED_PRODUCT_FILTER });
    if (!doc) doc = await findMasterDoc(db, 'products', scopeAuth, { barcode: code });
    if (doc?.mergedInto) doc = await findMasterDoc(db, 'products', scopeAuth, { id: String(doc.mergedInto) }) || doc;
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
      if (existing.deletedAt) return err('Produk sudah dihapus', 400);
      if (productBody.stok !== undefined || productBody.stokAlasan !== undefined) {
        return err('Stok tidak bisa diubah lewat master produk — gunakan Penyesuaian Stok', 400);
      }
      const canAdjustStock = userAuth.isMaster || STOCK_ADJUST_ROLES.includes(userAuth.role);
      if (!canAdjustStock && productBody.minStok !== undefined) {
        return err('Hanya Supervisor/Admin yang boleh mengubah stok minimum produk', 403);
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
      for (const k of PRODUCT_SERVER_OWNED_FIELDS) delete update[k];
      VENDOR_LOCKED_FIELDS.forEach((k) => delete update[k]);
      if (isVendorSyncedProduct(existing)) {
        VENDOR_PRICE_FIELDS.forEach((k) => delete update[k]);
      }
      if (productBody.nama !== undefined) {
        const nextNama = String(productBody.nama || '').trim();
        if (!nextNama) return err('Nama wajib diisi', 400);
        update.nama = nextNama;
        if (nextNama !== String(existing.nama || '').trim()) {
          // Sama seperti detail/foto: stamp LWW + push enrichment ke Sales.
          update.namaSource = 'manual';
          update.namaUpdatedAt = new Date();
          update.detailFotosUpdatedAt = new Date();
        }
      }
      const vendorSources = await db.collection('products').countDocuments({
        tenantId: existing.tenantId || 'default',
        mergedInto: id,
      });
      if (update.aktif === true && existing.aktif === false && !existing.mergedInto) {
        const activeTwin = await db.collection('products').findOne({
          tenantId: existing.tenantId || 'default',
          kode: String(update.kode || existing.kode),
          id: { $ne: id },
          aktif: { $ne: false },
          ...NOT_MERGED_PRODUCT_FILTER,
        }, { projection: { nama: 1 } });
        if (activeTwin) {
          return err(`Kode ${update.kode || existing.kode} sudah dipakai item aktif ${activeTwin.nama || ''} — gabungkan kode ganda lebih dulu`, 409);
        }
      }
      if (vendorSources && update.kode && update.kode !== existing.kode) {
        return err(`Kode tidak bisa diubah: ${vendorSources} sumber vendor tergabung ke item ini dengan kode ${existing.kode}`, 400);
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
      const tid = existing.tenantId || 'default';
      stripRecipeBridgeMeta(update);
      RECIPE_BRIDGE_VALUE_FIELDS.forEach((k) => delete update[k]);
      const bridge = resolveRecipeBridgeInput(productBody, existing.satuan, existing);
      if ('error' in bridge) return err(bridge.error, 400);
      if (bridge.changed) Object.assign(update, manualRecipeBridgeSet(bridge.values, new Date()));
      delete update.shelfLifeDays;
      delete update.requiresLotNo;
      const lotControl = resolveLotControlInput(productBody);
      if ('error' in lotControl) return err(lotControl.error, 400);
      const lotControlBefore = {
        shelfLifeDays: (existing.shelfLifeDays as number | null | undefined) ?? null,
        requiresLotNo: existing.requiresLotNo === true,
      };
      const lotControlAfter = { ...lotControlBefore, ...lotControl.values };
      const lotControlChanged = lotControlAfter.shelfLifeDays !== lotControlBefore.shelfLifeDays
        || lotControlAfter.requiresLotNo !== lotControlBefore.requiresLotNo;
      if (lotControlChanged && existing.mergedInto) {
        return err('Produk ini sudah digabung ke item persediaan lain — atur masa simpan & no. lot di item tersebut', 400);
      }
      Object.assign(update, lotControl.values);
      if (productBody.detailProduk !== undefined) {
        const detail = normalizeDetailProduk(productBody.detailProduk);
        if (typeof detail === 'object' && 'error' in detail) return err(detail.error, 400);
        update.detailProduk = detail;
        update.detailFotosUpdatedAt = new Date();
      }
      if (productBody.fotos !== undefined) {
        const fotos = await persistProductFotos(tid, productBody.fotos);
        if (!Array.isArray(fotos)) return err(fotos.error, 400);
        update.fotos = fotos;
        update.detailFotosUpdatedAt = new Date();
      }

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
          update.grup = grup;
        }
      }

      if (update.itemRole !== undefined) {
        if (!isItemRole(update.itemRole)) {
          return err('itemRole tidak valid (INGREDIENT|SEMI_FINISHED|FINISHED_GOOD|PACKAGING|CONSUMABLE)', 400);
        }
        update.itemRole = update.itemRole;
      }

      const classified = classifyProduct({
        grup: String(update.grup ?? existing.grup ?? ''),
        nama: String(update.nama ?? existing.nama ?? ''),
      });
      const followInferred = productBody.classificationSource === 'inferred';
      if (followInferred) {
        update.itemRole = classified.itemRole;
        update.gudangKode = classified.gudangKode;
        update.classificationSource = 'inferred';
      }

      if (update.gudangKode !== undefined || followInferred) {
        const nextGudang = String(update.gudangKode || classified.gudangKode || '').trim().toUpperCase();
        if (!isValidProductGudang(nextGudang)) {
          return err('Gudang produk tidak valid (GKERING / GBASAH / GJANITOR)', 400);
        }
        const currentGudang = resolveProductGudangKode(existing);
        if (nextGudang !== currentGudang) {
          const moved = await relocateProductWarehouseWithAudit(db, {
            tenantId: tid,
            product: existing,
            nextGudang,
            auth: userAuth,
            reason: followInferred
              ? `Ikuti klasifikasi otomatis ${classified.gudangKode}`
              : 'Pindah gudang via edit master produk',
          });
          if ('error' in moved) return err(moved.error, 400);
        }
        update.gudangKode = nextGudang;
      }

      if (!followInferred && (update.itemRole !== undefined || update.gudangKode !== undefined)) {
        update.classificationSource = resolveClassificationSource({
          itemRole: update.itemRole ?? existing.itemRole,
          gudangKode: update.gudangKode ?? existing.gudangKode,
          inferred: classified,
        });
      }
      if (
        vendorSources
        && update.satuan !== undefined
        && normalizeBaseSatuan(update.satuan) !== normalizeBaseSatuan(existing.satuan)
      ) {
        return err(`Satuan dasar tidak bisa diubah: ${vendorSources} sumber vendor tergabung ke item ini memakai satuan ${existing.satuan}`, 400);
      }
      if (uomToWrite) {
        try {
          await runInTransactionOrFallback(async ({ db: txDb, session }) => {
            await replaceProductUoms(txDb, tid, id, uomToWrite!, session);
            await txDb.collection('products').updateOne(
              withTenantFilter(scopeAuth, { id }),
              { $set: update },
              txOpts(session),
            );
            await recomputeProductStok(txDb, tid, id, session);
          });
        } catch (e: unknown) {
          if (isDuplicateKodeError(e)) return err('Kode sudah dipakai produk aktif lain di tenant ini', 409);
          const msg = e instanceof Error ? e.message : 'Gagal menyimpan satuan produk';
          return err(msg, 400);
        }
      } else {
        try {
          await db.collection('products').updateOne(
            withTenantFilter(scopeAuth, { id }),
            { $set: update },
          );
        } catch (e: unknown) {
          if (isDuplicateKodeError(e)) return err('Kode sudah dipakai produk aktif lain di tenant ini', 409);
          throw e;
        }
      }
      if (bridge.changed) {
        await writeAuditLog(db, {
          tenantId: tid,
          action: 'PRODUCT_RECIPE_BRIDGE',
          entityType: 'product',
          entityId: id,
          summary: `Konversi resep ${existing.kode} diubah manual`,
          metadata: {
            source: 'MASTER',
            before: {
              recipeBaseGrams: existing.recipeBaseGrams ?? null,
              recipeBaseMl: existing.recipeBaseMl ?? null,
              isiPerKemasan: existing.isiPerKemasan ?? null,
              satuanIsi: existing.satuanIsi ?? null,
            },
            after: bridge.values,
          },
          ...auditActor(userAuth),
        });
      }
      if (lotControlChanged) {
        await writeAuditLog(db, {
          tenantId: tid,
          action: 'PRODUCT_LOT_CONTROL',
          entityType: 'product',
          entityId: id,
          summary: `Masa simpan / no. lot wajib ${existing.kode} diubah`,
          metadata: { before: lotControlBefore, after: lotControlAfter },
          ...auditActor(userAuth),
        });
      }
      await invalidateDashboardSnapshot(db, tid);
      const doc = await findMasterDoc(db, 'products', auth, { id });
      if (!doc) return ok(clean(doc));
      const enriched = await loadProductWithUoms(db, tid, doc as Record<string, unknown>);
      if (
        isVendorSyncedProduct(existing)
        && (
          productBody.nama !== undefined
          || productBody.detailProduk !== undefined
          || productBody.fotos !== undefined
        )
      ) {
        const localId = String(enriched.id || id);
        const enrichInput = {
          tenantId: tid,
          productId: localId,
          vendorStokId: String(enriched.vendorStokId || existing.vendorStokId || ''),
          vendorTenantId: String(enriched.vendorTenantId || existing.vendorTenantId || ''),
          kode: String(enriched.kode || existing.kode || ''),
          nama: String(enriched.nama || existing.nama || ''),
          detailProduk: String(enriched.detailProduk ?? ''),
          fotos: Array.isArray(enriched.fotos) ? enriched.fotos.map(String) : [],
        };
        // Durability: pastikan outbox PENDING sebelum response — drain async.
        if (enrichInput.vendorTenantId) {
          try {
            await ensureProductEnrichmentOutboxPending(db, enrichInput);
          } catch (e) {
            console.warn(
              '[product-enrichment] ensure outbox failed',
              e instanceof Error ? e.message : e,
            );
          }
        }
        void drainEnsureProductEnrichment(db, enrichInput).then(async (r) => {
          if (!r.ok && !r.skipped) {
            console.warn('[product-enrichment] push failed', r.error);
            try {
              const { enqueueJob, scheduleJobProcessing, JOB_TYPES } = await import('@/lib/api/bg-jobs');
              await enqueueJob(db, {
                type: JOB_TYPES.PRODUCT_ENRICHMENT_SYNC,
                tenantId: tid,
                payload: {
                  productId: localId,
                  aggregateId: localId,
                  vendorTenantId: enrichInput.vendorTenantId,
                  vendorStokId: enrichInput.vendorStokId,
                  kode: enrichInput.kode,
                  nama: enrichInput.nama,
                  detailProduk: enrichInput.detailProduk,
                  fotos: enrichInput.fotos,
                  recoverOutbox: true,
                  dedupeKey: `enrich-put:${localId}`,
                },
              });
              scheduleJobProcessing(db, { limit: 2 });
            } catch {
              /* best-effort */
            }
          }
        }).catch((e) => {
          console.warn('[product-enrichment] push error', e instanceof Error ? e.message : e);
        });
      }
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
      const removed = await softDeleteProducts(db, tid, [id], auth);
      if (!removed.ok) return err(removed.error, removed.status);
      await invalidateDashboardSnapshot(db, tid);
      return ok({ message: 'deleted' });
    }
  }

  return null;
}
