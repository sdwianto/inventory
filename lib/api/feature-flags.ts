/** Feature flags per tenant — rollout bertahap (P3). */

import type { Db } from 'mongodb';

export interface TenantFeatureFlags {
  multiUomEnabled: boolean;
  offlineQueueEnabled: boolean;
  reportSnapshotsEnabled: boolean;
  /**
   * ADR-004 — tolak batch ber-foodSafetyStatus HOLD di jalur keluar.
   * Default aktif: penahanan hanya terjadi setelah kegagalan kritis benar-benar
   * tercatat, jadi ini bukan false positive. Flag ini kill switch darurat,
   * bukan opt-in bertahap.
   */
  foodSafetyHoldEnabled: boolean;
}

export const DEFAULT_FEATURE_FLAGS: TenantFeatureFlags = {
  multiUomEnabled: true,
  offlineQueueEnabled: true,
  reportSnapshotsEnabled: true,
  foodSafetyHoldEnabled: true,
};

export function mergeFeatureFlags(raw?: Record<string, unknown> | null): TenantFeatureFlags {
  const src = (raw?.features && typeof raw.features === 'object'
    ? raw.features
    : raw) as Record<string, unknown> | undefined;
  return {
    multiUomEnabled: src?.multiUomEnabled !== false,
    offlineQueueEnabled: src?.offlineQueueEnabled !== false,
    reportSnapshotsEnabled: src?.reportSnapshotsEnabled !== false,
    foodSafetyHoldEnabled: src?.foodSafetyHoldEnabled !== false,
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

/** ADR-004 — dipakai jalur keluar (distribusi / release) sebelum FEFO consume. */
export async function isFoodSafetyHoldEnforced(db: Db, tenantId: string): Promise<boolean> {
  const flags = await getTenantFeatureFlags(db, tenantId);
  return flags.foodSafetyHoldEnabled;
}
