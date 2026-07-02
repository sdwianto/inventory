/** Lookup & uniqueness user per tenant — email boleh sama lintas tenant. */

import type { Db } from 'mongodb';
import { verifyPassword } from './auth-helpers';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeUserEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export function emailMatchFilter(email: string): { email: string | { $regex: RegExp } } {
  const trimmed = String(email || '').trim();
  if (!trimmed) return { email: '' };
  return { email: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, 'i') } };
}

export async function findUsersByEmail(db: Db, email: string): Promise<Record<string, unknown>[]> {
  const normalized = normalizeUserEmail(email);
  if (!normalized) return [];

  const byNormalized = await db.collection('users').find({ emailNormalized: normalized }).toArray();
  if (byNormalized.length) return byNormalized;

  const trimmed = String(email || '').trim();
  const legacy = await db.collection('users').find(emailMatchFilter(trimmed)).toArray();
  if (legacy.length) {
    await Promise.all(
      legacy
        .filter((u) => !u.emailNormalized)
        .map((u) => db.collection('users').updateOne(
          { id: u.id },
          { $set: { emailNormalized: normalized } },
        )),
    );
  }
  return legacy;
}

export async function assertEmailAvailableInTenant(
  db: Db,
  email: string,
  tenantId: string,
  excludeUserId?: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const normalized = normalizeUserEmail(email);
  const filter: Record<string, unknown> = {
    tenantId,
    $or: [
      { emailNormalized: normalized },
      emailMatchFilter(email),
    ],
  };
  if (excludeUserId) filter.id = { $ne: excludeUserId };
  const existing = await db.collection('users').findOne(filter);
  if (existing) {
    return { ok: false, message: 'Email sudah terdaftar di tenant ini' };
  }
  return { ok: true };
}

export interface LoginTenantOption {
  tenantId: string;
  tenantName: string;
  role: string;
}

export type ResolveLoginResult =
  | { kind: 'user'; user: Record<string, unknown> }
  | { kind: 'invalid' }
  | { kind: 'pick_tenant'; tenants: LoginTenantOption[] };

export async function resolveLoginUser(
  db: Db,
  email: string,
  password: string,
  tenantId?: string,
): Promise<ResolveLoginResult> {
  const candidates = await findUsersByEmail(db, email);
  if (candidates.length === 0) return { kind: 'invalid' };

  if (tenantId) {
    const user = candidates.find((u) => String(u.tenantId ?? '') === tenantId);
    if (!user) return { kind: 'invalid' };
    const valid = await verifyPassword(password, String(user.password ?? ''));
    return valid ? { kind: 'user', user } : { kind: 'invalid' };
  }

  if (candidates.length === 1) {
    const user = candidates[0];
    const valid = await verifyPassword(password, String(user.password ?? ''));
    return valid ? { kind: 'user', user } : { kind: 'invalid' };
  }

  const validMatches: Record<string, unknown>[] = [];
  for (const user of candidates) {
    if (await verifyPassword(password, String(user.password ?? ''))) {
      validMatches.push(user);
    }
  }
  if (validMatches.length === 0) return { kind: 'invalid' };
  if (validMatches.length === 1) return { kind: 'user', user: validMatches[0] };

  return {
    kind: 'pick_tenant',
    tenants: validMatches.map((u) => ({
      tenantId: String(u.tenantId ?? 'default'),
      tenantName: String(u.tenantName ?? u.tenantId ?? '—'),
      role: String(u.role ?? ''),
    })),
  };
}

export function userEmailFields(email: string) {
  const normalized = normalizeUserEmail(email);
  return {
    email: String(email || '').trim(),
    emailNormalized: normalized,
  };
}
