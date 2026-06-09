// Master grup & satuan produk (per tenant).

import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  withTenantFilter,
  tenantIdForWrite,
  authForMasterActing,
  resolveActingTenantId,
} from '@/lib/api/tenant-master';
import { assertMasterAccess } from '@/lib/api/tenant-validate';
import { ensureProdukMetaForTenant } from '@/lib/api/product-meta';

function scopeAuth(auth, url, body) {
  const acting = resolveActingTenantId(auth, { url, body });
  if (auth?.isMaster && (url?.searchParams?.get('tenantId') || body?.tenantId)) {
    return authForMasterActing(auth, acting);
  }
  return auth;
}

function resolveTenantId(auth, url, body) {
  return tenantIdForWrite(auth, { tenantId: resolveActingTenantId(auth, { url, body }) });
}

async function listMeta(db, collection, auth, url) {
  const scoped = scopeAuth(auth, url);
  const tenantId = resolveActingTenantId(auth, { url });
  if (auth?.isMaster && !tenantId) {
    return err('Pilih tenant terlebih dahulu', 400);
  }
  await ensureProdukMetaForTenant(db, scoped.tenantId || tenantId);
  const list = await db.collection(collection)
    .find(withTenantFilter(scoped, { aktif: { $ne: false } }))
    .sort({ nama: 1 })
    .toArray();
  return ok(list.map(clean));
}

async function createMeta(db, collection, auth, body, url) {
  const nama = String(body?.nama || '').trim();
  if (!nama) return err('Nama wajib diisi');
  const tenantId = resolveTenantId(auth, url, body);
  await ensureProdukMetaForTenant(db, tenantId);
  const existing = await db.collection(collection).findOne({ tenantId, nama });
  if (existing) return err(`"${nama}" sudah terdaftar`, 409);
  const doc = {
    id: uuidv4(),
    tenantId,
    nama,
    aktif: true,
    createdAt: new Date(),
  };
  await db.collection(collection).insertOne(doc);
  return ok(clean(doc));
}

async function deleteMeta(db, collection, productField, auth, path, url) {
  const id = path[1];
  const access = await assertMasterAccess(db, auth, collection, { id });
  if (access.error) return access.error;
  const doc = access.doc;
  const inUse = await db.collection('products').countDocuments({
    tenantId: doc.tenantId,
    [productField]: doc.nama,
  });
  if (inUse > 0) {
    return err(`Tidak bisa hapus — masih dipakai ${inUse} produk`, 400);
  }
  await db.collection(collection).deleteOne(withTenantFilter(auth, { id }));
  return ok({ message: 'deleted', id });
}

export async function handleProductMeta({ db, route, method, path, body, url, auth }) {
  if (route === '/produk-grup' && method === 'GET') {
    return listMeta(db, 'produk_grup', auth, url);
  }
  if (route === '/produk-grup' && method === 'POST') {
    return createMeta(db, 'produk_grup', auth, body, url);
  }
  if (path[0] === 'produk-grup' && path.length === 2 && method === 'DELETE') {
    return deleteMeta(db, 'produk_grup', 'grup', auth, path, url);
  }

  if (route === '/produk-satuan' && method === 'GET') {
    return listMeta(db, 'produk_satuan', auth, url);
  }
  if (route === '/produk-satuan' && method === 'POST') {
    return createMeta(db, 'produk_satuan', auth, body, url);
  }
  if (path[0] === 'produk-satuan' && path.length === 2 && method === 'DELETE') {
    return deleteMeta(db, 'produk_satuan', 'satuan', auth, path, url);
  }

  return null;
}
