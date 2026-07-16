import { describe, expect, it } from 'vitest';
import {
  ITEM_ROLES,
  isItemRole,
  normalizeItemRole,
} from '@/lib/food-production/item-role';
import {
  appendDocHistory,
  assertStatusTransition,
  FP_DOC_PREFIX,
  FP_DOC_TYPES,
} from '@/lib/food-production/document';
import { normalizeKitchenWarehouse } from '@/lib/food-production/kitchen';

describe('food-production phase 0', () => {
  it('normalizes itemRole', () => {
    expect(ITEM_ROLES).toContain('INGREDIENT');
    expect(isItemRole('PACKAGING')).toBe(true);
    expect(isItemRole('WIDGET')).toBe(false);
    expect(normalizeItemRole(undefined)).toBe('INGREDIENT');
    expect(normalizeItemRole('FINISHED_GOOD')).toBe('FINISHED_GOOD');
  });

  it('enforces default status transitions', () => {
    expect(assertStatusTransition('DRAFT', 'SUBMITTED')).toBeNull();
    expect(assertStatusTransition('COMPLETED', 'DRAFT')).toMatch(/tidak boleh/);
  });

  it('appends document history', () => {
    const hist = appendDocHistory([], {
      at: new Date(),
      fromStatus: null,
      toStatus: 'DRAFT',
      userName: 'test',
    });
    expect(hist).toHaveLength(1);
    expect(hist[0].toStatus).toBe('DRAFT');
  });

  it('has FP document prefixes', () => {
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.PRODUCTION_PLAN]).toBe('RPN');
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.PRODUCTION_RESULT]).toBe('HSL');
  });

  it('maps kitchen warehouse to GKERING/GBASAH only', () => {
    expect(normalizeKitchenWarehouse('GKERING')).toBe('GKERING');
    expect(normalizeKitchenWarehouse('GBASAH')).toBe('GBASAH');
    expect(normalizeKitchenWarehouse('XYZ')).toBeNull();
  });
});
