import type { Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import type { AssetDoc, AssetStatus, MaintenancePriority } from '@/types/maintenance';
import { ASSET_STATUS_LABELS, BLOCKING_WR_STATUSES, MAINTENANCE_REQUESTS_COLLECTION } from '@/lib/maintenance/constants';

const VALID_ASSET_STATUS = new Set<string>(Object.keys(ASSET_STATUS_LABELS));
const VALID_PRIORITY = new Set<string>(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export async function actorSnapshot(db: Db, auth: AuthContext | null | undefined) {
  let userName = String(auth?.name || auth?.email || '').trim();
  let role = auth?.role || '';
  if (auth?.userId) {
    const u = await db.collection('users').findOne({ id: auth.userId });
    if (u) {
      if (!userName) userName = String(u.name || u.email || '').trim();
      if (!role) role = u.role || '';
    }
  }
  return {
    userId: auth?.userId || '',
    userName: userName || 'Pengguna',
    role,
  };
}

export function normalizeAssetStatus(value: unknown): AssetStatus {
  const s = String(value || 'ACTIVE').toUpperCase();
  return VALID_ASSET_STATUS.has(s) ? (s as AssetStatus) : 'ACTIVE';
}

export function normalizePriority(value: unknown): MaintenancePriority {
  const p = String(value || 'MEDIUM').toUpperCase();
  return VALID_PRIORITY.has(p) ? (p as MaintenancePriority) : 'MEDIUM';
}

export function buildAssetSearchFilter(q: string): Record<string, unknown> {
  const term = q.trim();
  if (!term) return {};
  const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return {
    $or: [
      { kode: rx },
      { nama: rx },
      { serialNumber: rx },
      { lokasi: rx },
      { merk: rx },
    ],
  };
}

export async function loadAssetForTenant(
  db: Db,
  tenantId: string,
  assetId: string,
): Promise<AssetDoc | null> {
  return db.collection('assets').findOne({ tenantId, id: assetId }) as Promise<AssetDoc | null>;
}

export async function assertAssetHasNoOpenRequests(
  db: Db,
  tenantId: string,
  assetId: string,
): Promise<string | null> {
  const open = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne({
    tenantId,
    assetId,
    status: { $in: BLOCKING_WR_STATUSES },
  });
  if (open) {
    return `Aset masih punya permintaan maintenance aktif (${open.noWR || open.id})`;
  }
  return null;
}

export async function syncAssetStatusFromOpenRequests(
  db: Db,
  tenantId: string,
  assetId: string,
): Promise<void> {
  const active = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne({
    tenantId,
    assetId,
    status: { $in: ['APPROVED', 'IN_PROGRESS', 'COMPLETED'] },
  });
  const asset = await loadAssetForTenant(db, tenantId, assetId);
  if (!asset) return;

  const nextStatus: AssetStatus = active ? 'IN_REPAIR' : 'ACTIVE';
  if (asset.status === nextStatus) return;
  if (asset.status === 'RETIRED' || asset.status === 'DISPOSED') return;

  await db.collection('assets').updateOne(
    { tenantId, id: assetId },
    { $set: { status: nextStatus, updatedAt: new Date() } },
  );
}
