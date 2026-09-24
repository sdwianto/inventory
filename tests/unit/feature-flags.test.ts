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

  it('flag fase 0.3 default mati dan hanya hidup bila true', () => {
    const off = mergeFeatureFlags(null);
    expect(off.pblReferenceMode).toBe(false);
    expect(off.rlFromPoReference).toBe(false);
    expect(off.strictRecipeConversion).toBe(false);
    expect(off.lotQcRequired).toBe(false);
    expect(off.planStockReservation).toBe(false);
    expect(off.costingV2).toBe(false);
    expect(off.adjustmentApproval).toBe(false);
    expect(mergeFeatureFlags({ features: { costingV2: 'yes' } }).costingV2).toBe(false);
    expect(mergeFeatureFlags({ features: { pblReferenceMode: true, lotQcRequired: true } })).toMatchObject({
      pblReferenceMode: true,
      lotQcRequired: true,
      costingV2: false,
    });
  });

  it('assertMultiUomAllowed allows single UOM without db', async () => {
    const msg = await assertMultiUomAllowed({ collection: () => ({ findOne: async () => null }) } as never, 't1', 1);
    expect(msg).toBeNull();
  });
});
