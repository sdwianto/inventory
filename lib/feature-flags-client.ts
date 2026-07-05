'use client';

import {
  DEFAULT_FEATURE_FLAGS,
  type TenantFeatureFlags,
} from '@/lib/api/feature-flags';

let cached: TenantFeatureFlags = { ...DEFAULT_FEATURE_FLAGS };

export function setClientFeatureFlags(flags?: Partial<TenantFeatureFlags> | null): void {
  if (!flags) {
    cached = { ...DEFAULT_FEATURE_FLAGS };
    return;
  }
  cached = {
    multiUomEnabled: flags.multiUomEnabled !== false,
    offlineQueueEnabled: flags.offlineQueueEnabled !== false,
    reportSnapshotsEnabled: flags.reportSnapshotsEnabled !== false,
  };
}

export function getClientFeatureFlags(): TenantFeatureFlags {
  return cached;
}

export function isOfflineQueueEnabled(): boolean {
  return cached.offlineQueueEnabled;
}
