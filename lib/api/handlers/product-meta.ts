import type { Db } from 'mongodb';
// Master grup & satuan produk (per tenant).

import type { NextResponse } from 'next/server';
import type { AuthContext } from '@/types/auth';
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
import type { HandlerContext } from '@/types/api/handler';

interface MetaBody {
  nama?: string;
}

async function listMeta(
  db: HandlerContext['db'],
  collection: string,
  scopeAuth: AuthContext,
  tenantId: string,
) {
  await ensureProdukMetaForTenant(db, tenantId);
  const list = await db.collection(collection)
    .find(withTenantFilter(scopeAuth, { aktif: { $ne: false } }))
    .sort({ nama: 1 })
    .toArray();
  return ok(list.map(clean));
}

async function createMeta(
  db: HandlerContext['db'],
  collection: string,
  scopeAuth: AuthContext,
  tenantId: string,
  body: MetaBody | null | undefined,
) {
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

async function deleteMeta(
  db: HandlerContext['db'],
  collection: string,
  field: string,
  scopeAuth: AuthContext,
  path: string[],
) {
  const access = await assertMasterAccess(db, scopeAuth, collection, { id: path[1] });
  if ('error' in access) return access.error;
  const metaDoc = access.doc;
  const inUse = await db.collection('products').countDocuments({
    tenantId: metaDoc.tenantId,
    [field]: metaDoc.nama,
    aktif: { $ne: false },
  });
  if (inUse > 0) return err(`Masih dipakai ${inUse} produk`, 400);
  await db.collection(collection).deleteOne(withTenantFilter(scopeAuth, { id: path[1] }));
  return ok({ message: 'deleted' });
}

export async function handleProductMeta({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const scopeCtx = { url, body: body as Record<string, unknown> | undefined, request };

  if (route === '/produk-grup' && method === 'GET') {
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, scopeCtx);
    if (denied) return denied;
    if (!scopeAuth || !tenantId) return err('Scope tidak valid', 400);
    return listMeta(db, 'produk_grup', scopeAuth, tenantId);
  }
  if (route === '/produk-grup' && method === 'POST') {
    const deniedRole = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeCtx);
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    return createMeta(db, 'produk_grup', scopeAuth, tenantIdForWrite(scopeAuth, body as Record<string, unknown>), body as MetaBody);
  }
  if (path[0] === 'produk-grup' && path.length === 2 && method === 'DELETE') {
    const deniedRole = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeCtx);
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    return deleteMeta(db, 'produk_grup', 'grup', scopeAuth, path);
  }

  if (route === '/produk-satuan' && method === 'GET') {
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, scopeCtx);
    if (denied) return denied;
    if (!scopeAuth || !tenantId) return err('Scope tidak valid', 400);
    return listMeta(db, 'produk_satuan', scopeAuth, tenantId);
  }
  if (route === '/produk-satuan' && method === 'POST') {
    const deniedRole = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeCtx);
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    return createMeta(db, 'produk_satuan', scopeAuth, tenantIdForWrite(scopeAuth, body as Record<string, unknown>), body as MetaBody);
  }
  if (path[0] === 'produk-satuan' && path.length === 2 && method === 'DELETE') {
    const deniedRole = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, scopeCtx);
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    return deleteMeta(db, 'produk_satuan', 'satuan', scopeAuth, path);
  }

  return null;
}
