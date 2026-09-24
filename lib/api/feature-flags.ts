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
  /** Fase 0.3 — opt-in per tenant, default mati sampai cutover. */
  pblReferenceMode: boolean;
  rlFromPoReference: boolean;
  strictRecipeConversion: boolean;
  lotQcRequired: boolean;
  planStockReservation: boolean;
  costingV2: boolean;
  adjustmentApproval: boolean;
}

export type OptInFeatureFlag = keyof Pick<
  TenantFeatureFlags,
  | 'pblReferenceMode'
  | 'rlFromPoReference'
  | 'strictRecipeConversion'
  | 'lotQcRequired'
  | 'planStockReservation'
  | 'costingV2'
  | 'adjustmentApproval'
>;

export const OPT_IN_FEATURE_FLAGS: readonly OptInFeatureFlag[] = [
  'pblReferenceMode',
  'rlFromPoReference',
  'strictRecipeConversion',
  'lotQcRequired',
  'planStockReservation',
  'costingV2',
  'adjustmentApproval',
];

export const DEFAULT_FEATURE_FLAGS: TenantFeatureFlags = {
  multiUomEnabled: true,
  offlineQueueEnabled: true,
  reportSnapshotsEnabled: true,
  foodSafetyHoldEnabled: true,
  pblReferenceMode: false,
  rlFromPoReference: false,
  strictRecipeConversion: false,
  lotQcRequired: false,
  planStockReservation: false,
  costingV2: false,
  adjustmentApproval: false,
};

export function mergeFeatureFlags(raw?: Record<string, unknown> | null): TenantFeatureFlags {
  const src = (raw?.features && typeof raw.features === 'object'
    ? raw.features
    : raw) as Record<string, unknown> | undefined;
  const optIn = Object.fromEntries(
    OPT_IN_FEATURE_FLAGS.map((key) => [key, src?.[key] === true]),
  ) as Pick<TenantFeatureFlags, OptInFeatureFlag>;
  return {
    multiUomEnabled: src?.multiUomEnabled !== false,
    offlineQueueEnabled: src?.offlineQueueEnabled !== false,
    reportSnapshotsEnabled: src?.reportSnapshotsEnabled !== false,
    foodSafetyHoldEnabled: src?.foodSafetyHoldEnabled !== false,
    ...optIn,
  };
}

export async function isTenantFeatureEnabled(
  db: Db,
  tenantId: string,
  flag: OptInFeatureFlag,
): Promise<boolean> {
  const flags = await getTenantFeatureFlags(db, tenantId);
  return flags[flag] === true;
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

/**
 * Fase 1.4 — PBL acuan (tanpa mutasi stok) hanya efektif bila RL dari acuan PO juga aktif:
 * RL dengan kontrol melebihi acuan menjadi satu-satunya pengeluaran aktual.
 */
export function isPblReferenceModeActive(flags: Pick<TenantFeatureFlags, 'pblReferenceMode' | 'rlFromPoReference'>): boolean {
  return flags.pblReferenceMode === true && flags.rlFromPoReference === true;
}

export async function isPblReferenceModeEnabled(db: Db, tenantId: string): Promise<boolean> {
  return isPblReferenceModeActive(await getTenantFeatureFlags(db, tenantId));
}

/** ADR-004 — dipakai jalur keluar (distribusi / release) sebelum FEFO consume. */
export async function isFoodSafetyHoldEnforced(db: Db, tenantId: string): Promise<boolean> {
  const flags = await getTenantFeatureFlags(db, tenantId);
  return flags.foodSafetyHoldEnabled;
}
