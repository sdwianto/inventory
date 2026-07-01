// Users CRUD handler — tenant scope dari session server.

import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { hashPassword } from '@/lib/api/auth-helpers';
import { requireAuth } from '@/lib/api/require-auth';
import { tenantFilterFromAuth, assertDocTenant } from '@/lib/api/tenant-scope';
import type { HandlerContext } from '@/types/api/handler';
import { assertEmailAvailableInTenant, normalizeUserEmail } from '@/lib/api/user-email';

const TENANT_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'OWNER'];
const ALL_ROLES = [...TENANT_ROLES, 'MASTER'];

interface UserDoc extends Record<string, unknown> {
  id: string;
  email: string;
  password?: string;
  name: string;
  role: string;
  tenantId?: string | null;
  tenantName?: string;
}

interface UserCreateBody {
  email?: string;
  password?: string;
  name?: string;
  role?: string;
  tenantId?: string;
  tenantName?: string;
}

interface UserBulkDeleteBody {
  ids?: unknown[];
}

function normalizeRole(role: string | undefined, isMaster: boolean): string | null {
  const r = String(role || 'GUDANG').toUpperCase();
  if (!ALL_ROLES.includes(r)) return null;
  if (r === 'MASTER' && !isMaster) return null;
  return r;
}

const stripPassword = (doc: UserDoc | null | undefined) => {
  const c = clean(doc) as Record<string, unknown>;
  delete c.password;
  return c;
};

export async function handleUsers({
  db,
  route,
  method,
  path,
  body,
  auth,
}: HandlerContext): Promise<NextResponse | null> {
  if (path[0] !== 'users' && !route.startsWith('/users')) return null;

  const denied = requireAuth(auth);
  if (denied) return denied;
  const userAuth = auth!;

  if (route === '/users' && method === 'GET') {
    const filter = userAuth.isMaster ? {} : tenantFilterFromAuth(userAuth);
    const list = await db.collection<UserDoc>('users').find(filter).sort({ createdAt: -1 }).toArray();
    return ok(list.map(stripPassword));
  }

  if (route === '/users/bulk-delete' && method === 'POST') {
    const bulkBody = (body || {}) as UserBulkDeleteBody;
    const ids = Array.isArray(bulkBody.ids) ? [...new Set(bulkBody.ids.map(String).filter(Boolean))] : [];
    if (ids.length === 0) return err('Tidak ada user dipilih', 400);
    const safeIds = ids.filter((id) => id !== userAuth.userId);
    if (safeIds.length === 0) return err('Tidak bisa hapus akun sendiri', 400);
    const filter = userAuth.isMaster
      ? { id: { $in: safeIds } }
      : { id: { $in: safeIds }, ...tenantFilterFromAuth(userAuth) };
    const found = await db.collection('users').countDocuments(filter);
    if (found === 0) return err('User tidak ditemukan atau tidak ada akses', 404);
    const result = await db.collection('users').deleteMany(filter);
    return ok({ deleted: result.deletedCount, requested: ids.length, skipped: ids.length - safeIds.length });
  }

  if (route === '/users' && method === 'POST') {
    const createBody = (body || {}) as UserCreateBody;
    if (!createBody.email || !createBody.password || !createBody.name) {
      return err('Email, password, nama wajib');
    }
    const role = normalizeRole(createBody.role, userAuth.isMaster);
    if (!role) return err('Role tidak valid', 400);
    const tenantId = userAuth.isMaster ? (createBody.tenantId || 'default') : userAuth.tenantId;
    const emailCheck = await assertEmailAvailableInTenant(db, createBody.email, tenantId);
    if (!emailCheck.ok) return err(emailCheck.message);
    const tenantName = userAuth.isMaster
      ? (createBody.tenantName || createBody.tenantId || '—')
      : userAuth.tenantName;
    const hashedPwd = await hashPassword(createBody.password);
    const doc: UserDoc = {
      id: uuidv4(),
      email: normalizeUserEmail(createBody.email),
      password: hashedPwd,
      name: createBody.name,
      role,
      tenantId,
      tenantName,
      aktif: true,
      createdAt: new Date(),
    };
    await db.collection('users').insertOne(doc);
    return ok(stripPassword(doc));
  }

  if (path[0] === 'users' && path.length === 2) {
    const id = path[1];
    const userFilter = userAuth.isMaster ? { id } : { id, ...tenantFilterFromAuth(userAuth) };
    const existing = await db.collection<UserDoc>('users').findOne(userFilter);
    if (!existing && method !== 'DELETE') return err('User tidak ditemukan', 404);

    if (method === 'PUT') {
      if (!existing) return err('User tidak ditemukan', 404);
      if (!assertDocTenant(existing, userAuth)) return err('Forbidden', 403);
      const updateBody = (body || {}) as UserCreateBody & Record<string, unknown>;
      const update: Record<string, unknown> = { ...updateBody, updatedAt: new Date() };
      delete update.id;
      delete update._id;
      if (!userAuth.isMaster) {
        delete update.tenantId;
        delete update.tenantName;
        const nextRole = normalizeRole(updateBody.role, false);
        if (updateBody.role !== undefined) {
          if (!nextRole) return err('Role tidak valid', 400);
          update.role = nextRole;
        }
      } else if (updateBody.role !== undefined) {
        const nextRole = normalizeRole(updateBody.role, true);
        if (!nextRole) return err('Role tidak valid', 400);
        update.role = nextRole;
      }
      const nextTenantId = String(update.tenantId ?? existing.tenantId ?? '');
      if (updateBody.email !== undefined) {
        update.email = normalizeUserEmail(String(updateBody.email));
        const emailCheck = await assertEmailAvailableInTenant(
          db,
          String(update.email),
          nextTenantId,
          existing.id,
        );
        if (!emailCheck.ok) return err(emailCheck.message);
      }
      if (!updateBody.password) delete update.password;
      else update.password = await hashPassword(updateBody.password);
      await db.collection('users').updateOne(userFilter, { $set: update });
      const doc = await db.collection<UserDoc>('users').findOne(userFilter);
      return ok(stripPassword(doc));
    }

    if (method === 'DELETE') {
      if (existing && !assertDocTenant(existing, userAuth)) return err('Forbidden', 403);
      await db.collection('users').deleteOne(userFilter);
      return ok({ message: 'deleted' });
    }
  }

  return null;
}
