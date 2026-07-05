/** Feature flags per tenant — rollout bertahap (P3). */

import type { Db } from 'mongodb';

export interface TenantFeatureFlags {
  multiUomEnabled: boolean;
  offlineQueueEnabled: boolean;
  reportSnapshotsEnabled: boolean;
}

export const DEFAULT_FEATURE_FLAGS: TenantFeatureFlags = {
  multiUomEnabled: true,
  offlineQueueEnabled: true,
  reportSnapshotsEnabled: true,
};

export function mergeFeatureFlags(raw?: Record<string, unknown> | null): TenantFeatureFlags {
  const src = (raw?.features && typeof raw.features === 'object'
    ? raw.features
    : raw) as Record<string, unknown> | undefined;
  return {
    multiUomEnabled: src?.multiUomEnabled !== false,
    offlineQueueEnabled: src?.offlineQueueEnabled !== false,
    reportSnapshotsEnabled: src?.reportSnapshotsEnabled !== false,
  };
}

export async function getTenantFeatureFlags(
  db: Db,
  tenantId: string,
): Promise<TenantFeatureFlags> {
  const row = await db.collection('tenant_settings').findOne(
    { tenantId },
    { projection: { features: 1 } },
  );
  return mergeFeatureFlags(row as Record<string, unknown> | null);
}

export async function assertMultiUomAllowed(
  db: Db,
  tenantId: string,
  uomCount: number,
): Promise<string | null> {
  if (uomCount <= 1) return null;
  const flags = await getTenantFeatureFlags(db, tenantId);
  if (!flags.multiUomEnabled) {
    return 'Multi-satuan dinonaktifkan untuk tenant ini. Aktifkan feature flag multiUomEnabled (MASTER).';
  }
  return null;
}
