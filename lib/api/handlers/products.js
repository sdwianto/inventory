// Products handler: master CRUD + code/barcode lookup (scoped per tenant).

import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  withTenantFilter,
  tenantIdForWrite,
  findMasterDoc,
  authForMasterActing,
  resolveActingTenantId,
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

const VENDOR_LOCKED_FIELDS = ['kode', 'nama', 'satuan', 'grup', 'barcode', 'syncSource', 'vendorStokId', 'vendorTenantId'];

export async function handleProducts({ db, route, method, path, body, url, auth }) {
  if (route === '/products' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    const grup = url.searchParams.get('grup') || '';
    const limit = parseInt(url.searchParams.get('limit') || '500', 10);
    let filter = buildProductSearchFilter(q);
    if (grup) filter.grup = grup;
    const acting = resolveActingTenantId(auth, { url });
    const scopeAuth = auth?.isMaster && url.searchParams.get('tenantId')
      ? authForMasterActing(auth, acting)
      : auth;
    filter = withTenantFilter(scopeAuth, filter);
    const list = await db.collection('products')
      .find(filter)
      .project(PRODUCT_LIST_PROJECTION)
      .sort({ nama: 1 })
      .limit(limit)
      .toArray();
    const tid = scopeAuth?.tenantId || acting || 'default';
    const enriched = await enrichProductsVendorNames(db, tid, list);
    const withWarehouseStock = url.searchParams.get('withWarehouseStock') === '1';
    if (withWarehouseStock && enriched.length > 0) {
      const stokMap = await getStokByWarehouseBatch(db, tid, enriched.map((p) => p.id));
      for (const p of enriched) {
        const byWh = stokMap.get(p.id) || Object.fromEntries(WAREHOUSE_CODES.map((k) => [k, 0]));
        p.stokByWarehouse = byWh;
      }
    }
    return ok(enriched.map(clean));
  }

  if (route === '/products' && method === 'POST') {
    const denied = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (denied) return denied;
    if (!body?.kode || !body?.nama) return err('Kode dan nama wajib');
    const tenantId = tenantIdForWrite(auth, body);
    const grup = String(body.grup || 'Umum').trim();
    const satuan = String(body.satuan || 'PCS').trim().toUpperCase();
    const metaCheck = await validateProdukGrupSatuan(db, tenantId, grup, satuan);
    if (metaCheck.error) return err(metaCheck.error, 400);
    const existing = await db.collection('products').findOne({ tenantId, kode: body.kode });
    if (existing) return err('Kode sudah ada di tenant ini');
    const draft = { grup, nama: body.nama };
    const gudangKode = isValidProductGudang(body.gudangKode)
      ? String(body.gudangKode).trim().toUpperCase()
      : inferGudangKodeFromProduct(draft);
    if (!isValidProductGudang(gudangKode)) {
      return err('Pilih gudang produk: GKERING (Kering) atau GBASAH (Basah)', 400);
    }
    const doc = {
      id: uuidv4(),
      tenantId,
      kode: body.kode,
      barcode: body.barcode || '',
      nama: body.nama,
      grup,
      satuan,
      gudangKode,
      hargaBeli: parseInt(body.hargaBeli || 0, 10),
      hargaSpesial: parseInt(body.hargaSpesial || 0, 10),
      hargaGrosir: parseInt(body.hargaGrosir || 0, 10),
      hargaEcer: parseInt(body.hargaEcer || 0, 10),
      stok: parseFloat(body.stok || 0),
      minStok: parseFloat(body.minStok || 0),
      aktif: body.aktif !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection('products').insertOne(doc);
    await setProductWarehouseStock(db, tenantId, doc.id, gudangKode, doc.stok);
    if (doc.stok > 0) {
      await recordMasterProductStockChange(db, {
        tenantId,
        product: doc,
        gudangKode,
        qtyBefore: 0,
        qtyAfter: doc.stok,
        auth,
        reason: 'Stok awal produk baru',
      });
    }
    const saved = await db.collection('products').findOne({ id: doc.id, tenantId });
    return ok(clean(saved || doc));
  }

  if (route === '/products/bulk-delete' && method === 'POST') {
    const denied = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (denied) return denied;
    return bulkDeleteMaster(db, auth, 'products', body?.ids);
  }

  if (route === '/products/lookup' && method === 'GET') {
    const code = (url.searchParams.get('code') || '').trim();
    if (!code) return err('code required');
    const acting = resolveActingTenantId(auth, { url });
    const scopeAuth = auth?.isMaster && url.searchParams.get('tenantId')
      ? authForMasterActing(auth, acting)
      : auth;
    let doc = await findMasterDoc(db, 'products', scopeAuth, { barcode: code });
    if (!doc) doc = await findMasterDoc(db, 'products', scopeAuth, { kode: code });
    if (!doc) return err('Produk tidak ditemukan', 404);
    return ok(clean(doc));
  }

  if (path[0] === 'products' && path.length === 2) {
    const id = path[1];
    const access = await assertMasterAccess(db, auth, 'products', { id });
    if (method === 'PUT') {
      if (access.error) return access.error;
      const existing = access.doc;
      const isGudang = auth.role === 'GUDANG' && !auth.isMaster;
      if (isGudang) {
        return err('Role GUDANG tidak boleh mengubah master produk', 403);
      }
      const canAdjustStock = auth.isMaster || STOCK_ADJUST_ROLES.includes(auth.role);
      if (!canAdjustStock && (body?.stok !== undefined || body?.minStok !== undefined)) {
        return err('Hanya Supervisor/Admin yang boleh mengubah stok produk', 403);
      }
      if (isVendorSyncedProduct(existing)) {
        for (const k of VENDOR_LOCKED_FIELDS) {
          if (body?.[k] !== undefined && body[k] !== existing[k]) {
            return err(`Field ${k} dikelola sales.app — edit di vendor`, 400);
          }
        }
      }
      const update = { ...(body || {}), updatedAt: new Date() };
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
        if (update[k] !== undefined) update[k] = parseInt(update[k] || 0, 10);
      });
      ['stok', 'minStok'].forEach((k) => {
        if (update[k] !== undefined) update[k] = parseFloat(update[k] || 0);
      });
      if (update.grup !== undefined || update.satuan !== undefined) {
        const grup = String(update.grup ?? existing.grup ?? 'Umum').trim();
        const satuan = String(update.satuan ?? existing.satuan ?? 'PCS').trim().toUpperCase();
        const metaCheck = await validateProdukGrupSatuan(db, existing.tenantId, grup, satuan);
        if (metaCheck.error) return err(metaCheck.error, 400);
        update.grup = grup;
        update.satuan = satuan;
      }
      const tid = existing.tenantId || 'default';
      if (update.gudangKode !== undefined) {
        const nextGudang = String(update.gudangKode || '').trim().toUpperCase();
        if (!isValidProductGudang(nextGudang)) {
          return err('Gudang produk tidak valid (GKERING atau GBASAH)', 400);
        }
        if (nextGudang !== resolveProductGudangKode(existing)) {
          const otherRows = await db.collection('stok_lokasi').find({
            tenantId: tid, stokId: id, lokasiKode: { $ne: nextGudang },
          }).toArray();
          const otherQty = otherRows.reduce((s, r) => s + (parseFloat(r.qty) || 0), 0);
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
        const qtyAfter = parseFloat(update.stok || 0);
        await setProductWarehouseStock(db, tid, id, gudang, qtyAfter);
        await recordMasterProductStockChange(db, {
          tenantId: tid,
          product: { ...existing, ...update, id },
          gudangKode: gudang,
          qtyBefore,
          qtyAfter,
          auth,
          reason: body?.stokAlasan || 'Penyesuaian via edit master produk',
        });
        update.stok = await syncProductStokFromLokasi(db, tid, id);
      }
      await db.collection('products').updateOne(
        withTenantFilter(auth, { id }),
        { $set: update },
      );
      const doc = await findMasterDoc(db, 'products', auth, { id });
      return ok(clean(doc));
    }
    if (method === 'DELETE') {
      const denied = requireRole(auth, PRODUCT_MANAGE_ROLES);
      if (denied) return denied;
      if (access.error) return access.error;
      if (isVendorSyncedProduct(access.doc)) {
        return err('Produk dari sales.app tidak bisa dihapus di inventory — nonaktifkan di vendor', 400);
      }
      await db.collection('products').deleteOne(withTenantFilter(auth, { id }));
      return ok({ message: 'deleted' });
    }
  }

  return null;
}
