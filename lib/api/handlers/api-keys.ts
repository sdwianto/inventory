import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { generateApiKey, hashApiKey } from '@/lib/api/api-key';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['OWNER', 'MASTER', 'ADMIN'] as const;
/** Mint only scopes that exist today. Write/public `*` deferred until scoped write API exists. */
const ALLOWED_SCOPES = new Set([
  'integrations',
  'food-production:read',
]);

export async function handleApiKeys(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const keyBody = (body || {}) as Record<string, unknown>;

  if (route === '/api-keys' && method === 'GET') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const list = await db.collection('api_keys')
      .find(withTenantFilter(scopeAuth, {}))
      .project({ keyHash: 0 })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/api-keys' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: keyBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const label = String(keyBody.label || '').trim() || 'Integration';
    const scopesRaw = Array.isArray(keyBody.scopes) ? keyBody.scopes.map(String) : ['food-production:read'];
    const scopes = scopesRaw.filter((s) => ALLOWED_SCOPES.has(s));
    if (!scopes.length) return err('scopes tidak valid', 400);

    const rawKey = generateApiKey();
    const tenantId = tenantIdForWrite(scopeAuth, keyBody);
    const now = new Date();
    const doc = {
      id: uuidv4(),
      tenantId,
      keyHash: hashApiKey(rawKey),
      label,
      scopes,
      role: 'INTEGRATION',
      aktif: true,
      createdAt: now,
      updatedAt: now,
      createdBy: auth.userId,
    };
    await db.collection('api_keys').insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'API_KEY_CREATE',
      entityType: 'api_key',
      entityId: doc.id,
      summary: `API key ${label} dibuat (${scopes.join(',')})`,
      ...auditActor(auth),
    });
    // Return raw key once — never stored in clear text.
    return ok({
      id: doc.id,
      label: doc.label,
      scopes: doc.scopes,
      apiKey: rawKey,
      warning: 'Simpan apiKey sekarang — tidak ditampilkan ulang',
    });
  }

  if (path[0] === 'api-keys' && path[1] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection('api_keys').findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('API key tidak ditemukan', 404);
    await db.collection('api_keys').updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      { $set: { aktif: false, updatedAt: new Date() } },
    );
    await writeAuditLog(db, {
      tenantId: String(existing.tenantId),
      action: 'API_KEY_REVOKE',
      entityType: 'api_key',
      entityId: path[1],
      summary: `API key ${String(existing.label || path[1])} dinonaktifkan`,
      ...auditActor(auth),
    });
    return ok({ id: path[1], aktif: false });
  }

  return null;
}
