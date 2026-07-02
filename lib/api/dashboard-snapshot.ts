/** Dashboard snapshot cache — TTL 2 menit per tenant. */

import type { Db } from 'mongodb';
import { createHash } from 'crypto';
import type { AuthContext } from '@/types/auth';
import { normalizeTenantId } from '@/lib/api/tenant-scope';

const COLLECTION = 'dashboard_snapshots';
const TTL_MS = 2 * 60_000;

let indexesEnsured = false;

function scopeHash(scopeAuth: AuthContext | null | undefined): string {
  const tid = normalizeTenantId(scopeAuth?.tenantId || 'default');
  const master = scopeAuth?.isMaster ? '1' : '0';
  return createHash('sha256').update(`${tid}:${master}`).digest('hex').slice(0, 16);
}

async function ensureIndexes(db: Db) {
  if (indexesEnsured) return;
  try {
    await db.collection(COLLECTION).createIndex(
      { tenantId: 1, scopeHash: 1 },
      { name: 'uniq_dashboard_snapshot_scope', unique: true },
    );
    await db.collection(COLLECTION).createIndex(
      { expiresAt: 1 },
      { name: 'idx_dashboard_snapshot_expires', expireAfterSeconds: 0 },
    );
  } catch (e) {
    const err = e as { code?: number; message?: string };
    if (err?.code !== 85 && err?.code !== 86) console.warn('dashboard_snapshots index:', err.message);
  }
  indexesEnsured = true;
}

export async function getDashboardSnapshot(
  db: Db,
  scopeAuth: AuthContext | null | undefined,
): Promise<Record<string, unknown> | null> {
  await ensureIndexes(db);
  const tenantId = normalizeTenantId(scopeAuth?.tenantId || 'default');
  const hash = scopeHash(scopeAuth);
  const row = await db.collection(COLLECTION).findOne({
    tenantId,
    scopeHash: hash,
    expiresAt: { $gt: new Date() },
  });
  return (row?.payload as Record<string, unknown> | undefined) || null;
}

export async function setDashboardSnapshot(
  db: Db,
  scopeAuth: AuthContext | null | undefined,
  payload: Record<string, unknown>,
) {
  await ensureIndexes(db);
  const tenantId = normalizeTenantId(scopeAuth?.tenantId || 'default');
  const hash = scopeHash(scopeAuth);
  const now = new Date();
  await db.collection(COLLECTION).updateOne(
    { tenantId, scopeHash: hash },
    {
      $set: {
        tenantId,
        scopeHash: hash,
        payload,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + TTL_MS),
      },
    },
    { upsert: true },
  );
}

export async function invalidateDashboardSnapshot(
  db: Db,
  tenantId: string | null | undefined,
) {
  await ensureIndexes(db);
  const tid = normalizeTenantId(tenantId || 'default');
  await db.collection(COLLECTION).deleteMany({ tenantId: tid });
}

export async function invalidateDashboardSnapshotsAll(db: Db) {
  await ensureIndexes(db);
  await db.collection(COLLECTION).deleteMany({});
}
