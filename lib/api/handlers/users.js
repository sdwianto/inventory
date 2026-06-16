// Users CRUD handler — tenant scope dari session server.

import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { hashPassword } from '@/lib/api/auth-helpers';
import { tenantFilterFromAuth, assertDocTenant } from '@/lib/api/tenant-scope';

const TENANT_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN'];
const ALL_ROLES = [...TENANT_ROLES, 'MASTER'];

function normalizeRole(role, isMaster) {
  const r = String(role || 'GUDANG').toUpperCase();
  if (!ALL_ROLES.includes(r)) return null;
  if (r === 'MASTER' && !isMaster) return null;
  return r;
}

const stripPassword = (doc) => {
  const c = clean(doc);
  delete c.password;
  return c;
};

export async function handleUsers({ db, route, method, path, body, auth }) {
  if (route === '/users' && method === 'GET') {
    const filter = auth.isMaster ? {} : tenantFilterFromAuth(auth);
    const list = await db.collection('users').find(filter).sort({ createdAt: -1 }).toArray();
    return ok(list.map(stripPassword));
  }

  if (route === '/users/bulk-delete' && method === 'POST') {
    const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(String).filter(Boolean))] : [];
    if (ids.length === 0) return err('Tidak ada user dipilih', 400);
    const safeIds = ids.filter((id) => id !== auth.userId);
    if (safeIds.length === 0) return err('Tidak bisa hapus akun sendiri', 400);
    const filter = auth.isMaster ? { id: { $in: safeIds } } : { id: { $in: safeIds }, ...tenantFilterFromAuth(auth) };
    const found = await db.collection('users').countDocuments(filter);
    if (found === 0) return err('User tidak ditemukan atau tidak ada akses', 404);
    const result = await db.collection('users').deleteMany(filter);
    return ok({ deleted: result.deletedCount, requested: ids.length, skipped: ids.length - safeIds.length });
  }

  if (route === '/users' && method === 'POST') {
    if (!body?.email || !body?.password || !body?.name) return err('Email, password, nama wajib');
    const existing = await db.collection('users').findOne({ email: body.email });
    if (existing) return err('Email sudah terdaftar');
    const role = normalizeRole(body.role, auth.isMaster);
    if (!role) return err('Role tidak valid', 400);
    const tenantId = auth.isMaster ? (body.tenantId || 'default') : auth.tenantId;
    const tenantName = auth.isMaster
      ? (body.tenantName || body.tenantId || '—')
      : auth.tenantName;
    const hashedPwd = await hashPassword(body.password);
    const doc = {
      id: uuidv4(),
      email: body.email,
      password: hashedPwd,
      name: body.name,
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
    const userFilter = auth.isMaster ? { id } : { id, ...tenantFilterFromAuth(auth) };
    const existing = await db.collection('users').findOne(userFilter);
    if (!existing && method !== 'DELETE') return err('User tidak ditemukan', 404);

    if (method === 'PUT') {
      if (!existing) return err('User tidak ditemukan', 404);
      if (!assertDocTenant(existing, auth)) return err('Forbidden', 403);
      const update = { ...(body || {}), updatedAt: new Date() };
      delete update.id;
      delete update._id;
      if (!auth.isMaster) {
        delete update.tenantId;
        delete update.tenantName;
        const nextRole = normalizeRole(body?.role, false);
        if (body?.role !== undefined) {
          if (!nextRole) return err('Role tidak valid', 400);
          update.role = nextRole;
        }
      } else if (body?.role !== undefined) {
        const nextRole = normalizeRole(body.role, true);
        if (!nextRole) return err('Role tidak valid', 400);
        update.role = nextRole;
      }
      if (!body?.password) delete update.password;
      else update.password = await hashPassword(body.password);
      await db.collection('users').updateOne(userFilter, { $set: update });
      const doc = await db.collection('users').findOne(userFilter);
      return ok(stripPassword(doc));
    }

    if (method === 'DELETE') {
      if (existing && !assertDocTenant(existing, auth)) return err('Forbidden', 403);
      await db.collection('users').deleteOne(userFilter);
      return ok({ message: 'deleted' });
    }
  }

  return null;
}
