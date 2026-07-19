import { describe, expect, it } from 'vitest';
import {
  normalizePlanLines,
  isPlanEditable,
  isIsoDate,
  totalTargetPorsi,
  summarizePlanLines,
  PLAN_STATUS_LABELS,
} from '@/lib/food-production/production-plan';
import { assertStatusTransition, FP_DOC_PREFIX, FP_DOC_TYPES } from '@/lib/food-production/document';

describe('food-production sprint 3 — production plan', () => {
  it('uses RPN document prefix', () => {
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.PRODUCTION_PLAN]).toBe('RPN');
  });

  it('validates ISO dates', () => {
    expect(isIsoDate('2026-07-15')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('15-07-2026')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });

  it('validates plan lines', () => {
    expect(normalizePlanLines([])).toEqual({ error: expect.stringMatching(/minimal 1/i) });
    expect(normalizePlanLines([{ recipeId: '', targetPorsi: 10 }])).toEqual({
      error: expect.stringMatching(/resep/i),
    });
    expect(normalizePlanLines([{ recipeId: 'r1', targetPorsi: 0 }])).toEqual({
      error: expect.stringMatching(/porsi/i),
    });
    expect(normalizePlanLines([
      { recipeId: 'r1', targetPorsi: 100 },
      { recipeId: 'r1', targetPorsi: 50 },
    ])).toEqual({ error: expect.stringMatching(/duplikat/i) });

    const okRecipe = normalizePlanLines([{ recipeId: 'r1', targetPorsi: 120, notes: 'siang' }]);
    expect(okRecipe).toEqual([
      {
        recipeId: 'r1',
        targetPorsi: 120,
        notes: 'siang',
        recipeKode: undefined,
        recipeNama: undefined,
      },
    ]);

    // Legacy menu lines still accepted
    const okMenu = normalizePlanLines([{ menuId: 'm1', targetPorsi: 80 }]);
    expect(okMenu).toEqual([
      {
        menuId: 'm1',
        targetPorsi: 80,
        notes: undefined,
        menuKode: undefined,
        menuNama: undefined,
      },
    ]);
  });

  it('sums / summarizes lines and gates edit by status', () => {
    const lines = [
      { recipeId: 'a', targetPorsi: 100, recipeNama: 'Nasi' },
      { recipeId: 'b', targetPorsi: 50, recipeNama: 'Soto' },
    ];
    expect(totalTargetPorsi(lines)).toBe(150);
    expect(summarizePlanLines(lines)).toContain('Nasi (100)');
    expect(isPlanEditable('DRAFT')).toBe(true);
    expect(isPlanEditable('SUBMITTED')).toBe(true);
    expect(isPlanEditable('APPROVED')).toBe(false);
    expect(isPlanEditable('COMPLETED')).toBe(false);
    expect(PLAN_STATUS_LABELS.APPROVED).toBe('Disetujui');
  });

  it('allows plan lifecycle transitions', () => {
    expect(assertStatusTransition('DRAFT', 'SUBMITTED')).toBeNull();
    expect(assertStatusTransition('SUBMITTED', 'APPROVED')).toBeNull();
    expect(assertStatusTransition('APPROVED', 'PROCESSING')).toBeNull();
    expect(assertStatusTransition('PROCESSING', 'COMPLETED')).toBeNull();
    expect(assertStatusTransition('COMPLETED', 'DRAFT')).toMatch(/tidak boleh/);
  });
});
