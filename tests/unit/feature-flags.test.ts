import { describe, it, expect } from 'vitest';
import {
  mergeFeatureFlags,
  DEFAULT_FEATURE_FLAGS,
  assertMultiUomAllowed,
} from '@/lib/api/feature-flags';

describe('feature-flags', () => {
  it('defaults all flags enabled', () => {
    expect(mergeFeatureFlags(null)).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(mergeFeatureFlags({})).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it('respects explicit false', () => {
    expect(mergeFeatureFlags({ features: { multiUomEnabled: false } }).multiUomEnabled).toBe(false);
  });

  it('assertMultiUomAllowed allows single UOM without db', async () => {
    const msg = await assertMultiUomAllowed({ collection: () => ({ findOne: async () => null }) } as never, 't1', 1);
    expect(msg).toBeNull();
  });
});
