import type { Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import type { MaintenanceRequestDoc, MaintenanceResolutionType } from '@/types/maintenance';
import { MAINTENANCE_REQUESTS_COLLECTION } from '@/lib/maintenance/constants';
import { withTenantFilter } from '@/lib/api/tenant-master';

export const WR_RESOLVABLE_STATUSES = new Set(['APPROVED', 'IN_PROGRESS']);

export async function loadWrById(
  db: Db,
  scopeAuth: AuthContext | null,
  wrId: string,
): Promise<MaintenanceRequestDoc | null> {
  return db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { id: wrId }),
  ) as Promise<MaintenanceRequestDoc | null>;
}

export function assertWrResolvable(
  wr: MaintenanceRequestDoc | null,
  nextType: MaintenanceResolutionType,
): string | null {
  if (!wr) return 'Permintaan maintenance tidak ditemukan';
  if (!WR_RESOLVABLE_STATUSES.has(String(wr.status || ''))) {
    return 'Hanya permintaan APPROVED atau IN_PROGRESS yang bisa ditindaklanjuti';
  }
  const existing = wr.resolutionType as MaintenanceResolutionType | undefined;
  if (existing && existing !== nextType) {
    return `Sudah ditindaklanjuti via ${existing} — tidak bisa ganti jalur`;
  }
  return null;
}

export async function applyWrResolutionLink(
  db: Db,
  wr: MaintenanceRequestDoc,
  patch: {
    resolutionType: MaintenanceResolutionType;
    linkedPoId?: string | null;
    linkedPoNo?: string | null;
    linkedReleaseId?: string | null;
    linkedReleaseNo?: string | null;
    linkedServiceOrderId?: string | null;
    linkedServiceOrderNo?: string | null;
  },
): Promise<void> {
  const now = new Date();
  const status = String(wr.status || '');
  const set: Record<string, unknown> = {
    ...patch,
    updatedAt: now,
  };
  if (status === 'APPROVED') {
    set.status = 'IN_PROGRESS';
    set.startedAt = wr.startedAt || now;
  }
  await db.collection(MAINTENANCE_REQUESTS_COLLECTION).updateOne(
    { id: wr.id },
    { $set: set },
  );
}

export function buildPoCatatanFromWr(wr: MaintenanceRequestDoc): string {
  const parts = [
    `[Maintenance ${wr.noWR || ''}]`.trim(),
    wr.judul ? String(wr.judul) : '',
    wr.assetKode ? `Aset: ${wr.assetKode} — ${wr.assetNama || ''}` : '',
    wr.deskripsi ? String(wr.deskripsi) : '',
  ].filter(Boolean);
  return parts.join(' · ').slice(0, 2000);
}

export function buildReleaseKeperluanFromWr(wr: MaintenanceRequestDoc): string {
  return `Maintenance ${wr.noWR || ''}: ${wr.judul || 'Perbaikan aset'}`.slice(0, 500);
}
