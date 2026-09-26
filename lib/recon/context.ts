import type { Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import { INVENTORY_CUTOVER_JOURNAL_SOURCE } from '@/lib/api/stock-cost-journal';
import { MIGRATION_RUNS_COLLECTION } from '@/lib/migrations/types';
import { INVENTORY_GL_CUTOVER_ID } from '@/lib/migrations/0008-inventory-gl-cutover';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';

const NON_TENANT_IDS = new Set(['', 'system']);

/** Tenant yang punya data: `tenants`, `tenant_settings`, dan pemilik produk. */
export async function listReconTenantIds(db: Db): Promise<string[]> {
  const [fromTenants, fromSettings, fromProducts] = await Promise.all([
    db.collection('tenants').distinct('id') as Promise<unknown[]>,
    db.collection('tenant_settings').distinct('tenantId') as Promise<unknown[]>,
    db.collection('products').distinct('tenantId') as Promise<unknown[]>,
  ]);
  const ids = new Set<string>();
  for (const v of [...fromTenants, ...fromSettings, ...fromProducts]) {
    const id = String(v ?? '').trim();
    if (!NON_TENANT_IDS.has(id)) ids.add(id);
  }
  return [...ids].sort();
}

/** Scope baca satu tenant untuk helper yang memakai `withTenantFilter`. */
export function reconScopeAuth(tenantId: string): AuthContext {
  return {
    userId: 'system:recon',
    email: '',
    name: 'Rekonsiliasi harian',
    role: 'ADMIN',
    tenantId,
    tenantName: tenantId,
    isMaster: false,
  };
}

/**
 * Titik mulai costingV2: jurnal cutover pertama, atau run migrasi 0008 yang berhasil tanpa jurnal
 * (GL sudah sama dengan nilai stok). `null` bila costingV2 mati atau cutover belum dijalankan.
 */
export async function resolveCostingCutoverAt(db: Db, tenantId: string): Promise<Date | null> {
  if (!(await isTenantFeatureEnabled(db, tenantId, 'costingV2'))) return null;
  const journal = await db.collection('jurnal').findOne(
    { tenantId, sourceType: INVENTORY_CUTOVER_JOURNAL_SOURCE },
    { sort: { createdAt: 1 }, projection: { createdAt: 1, tanggal: 1 } },
  );
  const fromJournal = journal?.createdAt || journal?.tanggal;
  if (fromJournal) return new Date(fromJournal as Date);
  const run = await db.collection(MIGRATION_RUNS_COLLECTION).findOne(
    { migrationId: INVENTORY_GL_CUTOVER_ID, tenantId, mode: 'APPLY', status: 'OK' },
    { sort: { finishedAt: 1 }, projection: { finishedAt: 1, startedAt: 1 } },
  );
  const fromRun = run?.finishedAt || run?.startedAt;
  return fromRun ? new Date(fromRun as Date) : null;
}
