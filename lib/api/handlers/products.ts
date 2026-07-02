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
import { buildProductSearchFilter, PRODUCT_LIST_PROJECTION } from '@/lib/api/product-query';
import { validateProdukGrupSatuan } from '@/lib/api/product-meta';
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
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';

const VENDOR_LOCKED_FIELDS = ['kode', 'nama', 'satuan', 'grup', 'barcode', 'syncSource', 'vendorStokId', 'vendorTenantId'];

interface ProductBody extends Record<string, unknown> {
  kode?: string;
  nama?: string;
  barcode?: string;
  grup?: string;
  satuan?: string;
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
    const idsParam = (url.searchParams.get('ids') || '').trim();
    const skip = Math.max(parseInt(url.searchParams.get('skip') || '0', 10) || 0, 0);
    let filter: Record<string, unknown> = buildProductSearchFilter(q);
    if (grup) filter.grup = grup;
    if (idsParam) {
      const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length) filter.id = { $in: ids };
    }
    filter = withTenantFilter(scopeAuth, filter);

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
    const withWarehouseStock = url.searchParams.get('withWarehouseStock') === '1';
    if (withWarehouseStock && enriched.length > 0) {
      const stokMap = await getStokByWarehouseBatch(db, tid, enriched.map((p) => p.id));
      for (const p of enriched) {
        const byWh = stokMap.get(p.id) || Object.fromEntries(WAREHOUSE_CODES.map((k) => [k, 0]));
        (p as ProductDoc & { stokByWarehouse?: Record<string, number> }).stokByWarehouse = byWh;
      }
    }
    const cleaned = enriched.map(clean);

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
    const satuan = String(productBody.satuan || 'PCS').trim().toUpperCase();
    const metaCheck = await validateProdukGrupSatuan(db, tenantId, grup, satuan);
    if ('error' in metaCheck) return err(metaCheck.error, 400);

    const existing = await db.collection('products').findOne({
      tenantId,
      kode: productBody.kode,
      $or: [{ syncSource: { $exists: false } }, { syncSource: { $ne: 'sales.app' } }],
    });
    if (existing) return err('Kode sudah ada di tenant ini');

    const draft = { grup, nama: productBody.nama };
    const gudangKode = isValidProductGudang(productBody.gudangKode)
      ? String(productBody.gudangKode).trim().toUpperCase()
      : inferGudangKodeFromProduct(draft);
    if (!isValidProductGudang(gudangKode)) {
      return err('Pilih gudang produk: GKERING (Kering) atau GBASAH (Basah)', 400);
    }

    const doc: ProductDoc = {
      id: uuidv4(),
      tenantId,
      kode: productBody.kode,
      barcode: productBody.barcode || '',
      nama: productBody.nama,
      grup,
      satuan,
      gudangKode,
      hargaBeli: parseInt(String(productBody.hargaBeli || 0), 10),
      hargaSpesial: parseInt(String(productBody.hargaSpesial || 0), 10),
      hargaGrosir: parseInt(String(productBody.hargaGrosir || 0), 10),
      hargaEcer: parseInt(String(productBody.hargaEcer || 0), 10),
      stok: parseFloat(String(productBody.stok || 0)),
      minStok: parseFloat(String(productBody.minStok || 0)),
      aktif: productBody.aktif !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection('products').insertOne(doc);
    await setProductWarehouseStock(db, tenantId, doc.id, gudangKode, doc.stok || 0);
    if ((doc.stok || 0) > 0) {
      await recordMasterProductStockChange(db, {
        tenantId,
        product: doc,
        gudangKode,
        qtyBefore: 0,
        qtyAfter: doc.stok || 0,
        auth: scopeAuth,
        reason: 'Stok awal produk baru',
      });
    }
    await refreshGrnsForProductKode(db, tenantId, doc.kode);
    await invalidateDashboardSnapshot(db, tenantId);
    const saved = await db.collection('products').findOne({ id: doc.id, tenantId });
    return ok(clean(saved || doc));
  }

  if (route === '/products/bulk-delete' && method === 'POST') {
    const deniedRole = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: productBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    return bulkDeleteMaster(db, scopeAuth, 'products', productBody.ids);
  }

  if (route === '/products/lookup' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const code = (url.searchParams.get('code') || '').trim();
    if (!code) return err('code required');
    let doc = await findMasterDoc(db, 'products', scopeAuth, { barcode: code });
    if (!doc) doc = await findMasterDoc(db, 'products', scopeAuth, { kode: code });
    if (!doc) return err('Produk tidak ditemukan', 404);
    return ok(clean(doc));
  }

  if (path[0] === 'products' && path.length === 2) {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: productBody, request });
    if (denied) return denied;
    if (!scopeAuth || !auth) return err('Scope tidak valid', 400);

    const id = path[1];
    const access = await assertMasterAccess(db, scopeAuth, 'products', { id });
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
      }
      const update: Record<string, unknown> = { ...productBody, updatedAt: new Date() };
      delete update.id;
      delete update._id;
      delete update.tenantId;
      VENDOR_LOCKED_FIELDS.forEach((k) => delete update[k]);
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
      if (update.grup !== undefined || update.satuan !== undefined) {
        const nextGrup = String(update.grup ?? existing.grup ?? 'Umum').trim();
        const nextSatuan = String(update.satuan ?? existing.satuan ?? 'PCS').trim().toUpperCase();
        const metaCheck = await validateProdukGrupSatuan(db, existing.tenantId, nextGrup, nextSatuan);
        if ('error' in metaCheck) return err(metaCheck.error, 400);
        update.grup = nextGrup;
        update.satuan = nextSatuan;
      }
      const tid = existing.tenantId || 'default';
      if (update.gudangKode !== undefined) {
        const nextGudang = String(update.gudangKode || '').trim().toUpperCase();
        if (!isValidProductGudang(nextGudang)) {
          return err('Gudang produk tidak valid (GKERING atau GBASAH)', 400);
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
        const qtyBefore = await getQtyStokLokasi(db, tid, id, gudang);
        const qtyAfter = parseFloat(String(update.stok || 0));
        await setProductWarehouseStock(db, tid, id, gudang, qtyAfter);
        await recordMasterProductStockChange(db, {
          tenantId: tid,
          product: { ...existing, ...update, id },
          gudangKode: gudang,
          qtyBefore,
          qtyAfter,
          auth: userAuth,
          reason: productBody.stokAlasan || 'Penyesuaian via edit master produk',
        });
        update.stok = await syncProductStokFromLokasi(db, tid, id);
      }
      await db.collection('products').updateOne(
        withTenantFilter(scopeAuth, { id }),
        { $set: update },
      );
      await invalidateDashboardSnapshot(db, tid);
      const doc = await findMasterDoc(db, 'products', auth, { id });
      return ok(clean(doc));
    }
    if (method === 'DELETE') {
      const denied = requireRole(auth, PRODUCT_MANAGE_ROLES);
      if (denied) return denied;
      if ('error' in access) return access.error;
      if (isVendorSyncedProduct(access.doc)) {
        return err('Produk dari sales.app tidak bisa dihapus di inventory — nonaktifkan di vendor', 400);
      }
      await db.collection('products').deleteOne(withTenantFilter(scopeAuth, { id }));
      await invalidateDashboardSnapshot(db, String(access.doc.tenantId || auth?.tenantId || 'default'));
      return ok({ message: 'deleted' });
    }
  }

  return null;
}
