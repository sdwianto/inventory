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
import { ensureStokLokasiRow, setQtyStokLokasi, syncProductStokFromLokasi } from '@/lib/api/stok-lokasi';
import { isVendorSyncedProduct } from '@/lib/api/product-sync';

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
    return ok(list.map(clean));
  }

  if (route === '/products' && method === 'POST') {
    if (!body?.kode || !body?.nama) return err('Kode dan nama wajib');
    const tenantId = tenantIdForWrite(auth, body);
    const grup = String(body.grup || 'Umum').trim();
    const satuan = String(body.satuan || 'PCS').trim().toUpperCase();
    const metaCheck = await validateProdukGrupSatuan(db, tenantId, grup, satuan);
    if (metaCheck.error) return err(metaCheck.error, 400);
    const existing = await db.collection('products').findOne({ tenantId, kode: body.kode });
    if (existing) return err('Kode sudah ada di tenant ini');
    const doc = {
      id: uuidv4(),
      tenantId,
      kode: body.kode,
      barcode: body.barcode || '',
      nama: body.nama,
      grup,
      satuan,
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
    await ensureStokLokasiRow(db, tenantId, doc.id, 'L001');
    if (doc.stok > 0) {
      await setQtyStokLokasi(db, tenantId, doc.id, 'L001', doc.stok);
    }
    await syncProductStokFromLokasi(db, tenantId, doc.id);
    const saved = await db.collection('products').findOne({ id: doc.id, tenantId });
    return ok(clean(saved || doc));
  }

  if (route === '/products/bulk-delete' && method === 'POST') {
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
      const stokDiubah = update.stok !== undefined;
      const lokasiRows = stokDiubah
        ? await db.collection('stok_lokasi').countDocuments({ tenantId: tid, stokId: id })
        : 0;
      if (stokDiubah) {
        if (lokasiRows <= 1) {
          await ensureStokLokasiRow(db, tid, id, 'L001');
          await setQtyStokLokasi(db, tid, id, 'L001', parseFloat(update.stok || 0));
          update.stok = await syncProductStokFromLokasi(db, tid, id);
        } else {
          delete update.stok;
        }
      }
      await db.collection('products').updateOne(
        withTenantFilter(auth, { id }),
        { $set: update },
      );
      const doc = await findMasterDoc(db, 'products', auth, { id });
      return ok(clean(doc));
    }
    if (method === 'DELETE') {
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
