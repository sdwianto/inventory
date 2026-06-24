// Master grup & satuan produk (per tenant).

import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  withTenantFilter,
  tenantIdForWrite,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { assertMasterAccess } from '@/lib/api/tenant-validate';
import { ensureProdukMetaForTenant } from '@/lib/api/product-meta';
import { requireRole, PRODUCT_MANAGE_ROLES } from '@/lib/api/require-auth';

async function listMeta(db, collection, scopeAuth, tenantId) {
  await ensureProdukMetaForTenant(db, tenantId);
  const list = await db.collection(collection)
    .find(withTenantFilter(scopeAuth, { aktif: { $ne: false } }))
    .sort({ nama: 1 })
    .toArray();
  return ok(list.map(clean));
}

async function createMeta(db, collection, scopeAuth, tenantId, body) {
  const nama = String(body?.nama || '').trim();
  if (!nama) return err('Nama wajib diisi');
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

async function deleteMeta(db, collection, field, scopeAuth, path) {
  const access = await assertMasterAccess(db, scopeAuth, collection, { id: path[1] });
  if (access.error) return access.error;
  const inUse = await db.collection('products').countDocuments({
    tenantId: access.doc.tenantId,
    [field]: access.doc.nama,
    aktif: { $ne: false },
  });
  if (inUse > 0) return err(`Masih dipakai ${inUse} produk`, 400);
  await db.collection(collection).deleteOne(withTenantFilter(scopeAuth, { id: path[1] }));
  return ok({ message: 'deleted' });
}

export async function handleProductMeta({ db, route, method, path, body, url, auth, request }) {
  const scopeCtx = { url, body, request };

  if (route === '/produk-grup' && method === 'GET') {
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, scopeCtx);
    if (denied) return denied;
    return listMeta(db, 'produk_grup', scopeAuth, tenantId);
  }
  if (route === '/produk-grup' && method === 'POST') {
    const deniedRole = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, scopeCtx);
    if (denied) return denied;
    return createMeta(db, 'produk_grup', scopeAuth, tenantIdForWrite(scopeAuth, body), body);
  }
  if (path[0] === 'produk-grup' && path.length === 2 && method === 'DELETE') {
    const deniedRole = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeCtx);
    if (denied) return denied;
    return deleteMeta(db, 'produk_grup', 'grup', scopeAuth, path);
  }

  if (route === '/produk-satuan' && method === 'GET') {
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, scopeCtx);
    if (denied) return denied;
    return listMeta(db, 'produk_satuan', scopeAuth, tenantId);
  }
  if (route === '/produk-satuan' && method === 'POST') {
    const deniedRole = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, scopeCtx);
    if (denied) return denied;
    return createMeta(db, 'produk_satuan', scopeAuth, tenantIdForWrite(scopeAuth, body), body);
  }
  if (path[0] === 'produk-satuan' && path.length === 2 && method === 'DELETE') {
    const deniedRole = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeCtx);
    if (denied) return denied;
    return deleteMeta(db, 'produk_satuan', 'satuan', scopeAuth, path);
  }

  return null;
}
