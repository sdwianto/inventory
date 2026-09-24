'use client';

import {
  DEFAULT_FEATURE_FLAGS,
  OPT_IN_FEATURE_FLAGS,
  type TenantFeatureFlags,
} from '@/lib/api/feature-flags';

let cached: TenantFeatureFlags = { ...DEFAULT_FEATURE_FLAGS };

export function setClientFeatureFlags(flags?: Partial<TenantFeatureFlags> | null): void {
  if (!flags) {
    cached = { ...DEFAULT_FEATURE_FLAGS };
    return;
  }
  const optIn = Object.fromEntries(
    OPT_IN_FEATURE_FLAGS.map((key) => [key, flags[key] === true]),
  ) as Pick<TenantFeatureFlags, (typeof OPT_IN_FEATURE_FLAGS)[number]>;
  cached = {
    multiUomEnabled: flags.multiUomEnabled !== false,
    offlineQueueEnabled: flags.offlineQueueEnabled !== false,
    reportSnapshotsEnabled: flags.reportSnapshotsEnabled !== false,
    foodSafetyHoldEnabled: flags.foodSafetyHoldEnabled !== false,
    ...optIn,
  };
}

export function getClientFeatureFlags(): TenantFeatureFlags {
  return cached;
}

export function isOfflineQueueEnabled(): boolean {
  return cached.offlineQueueEnabled;
}
