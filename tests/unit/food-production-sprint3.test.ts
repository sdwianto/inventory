import { describe, expect, it } from 'vitest';
import {
  normalizePlanLines,
  isPlanEditable,
  isIsoDate,
  totalTargetPorsi,
  summarizePlanLines,
  PLAN_STATUS_LABELS,
  mergeProductionPlanLines,
  mergeKategoriPorsiLists,
  mergeRecipeBufferPct,
  assertConsolidatePlans,
  consolidateBlockedReason,
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

  it('merges distinct recipes into separate lines', () => {
    const lines = mergeProductionPlanLines([
      { lines: [{ recipeId: 'jus', recipeNama: 'Jus Buah', targetPorsi: 1200, kategoriPorsiList: ['PORSI_KECIL'] }] },
      { lines: [{ recipeId: 'nasi', recipeNama: 'Nasi', targetPorsi: 800, kategoriPorsiList: ['PORSI_BESAR'] }] },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0].recipeId).toBe('jus');
    expect(lines[0].targetPorsi).toBe(1200);
    expect(lines[1].recipeId).toBe('nasi');
    expect(totalTargetPorsi(lines)).toBe(2000);
  });

  it('merges same recipe: sum porsi and union kategori', () => {
    const lines = mergeProductionPlanLines([
      { lines: [{ recipeId: 'jus', targetPorsi: 1200, kategoriPorsiList: ['PORSI_KECIL'] }] },
      { lines: [{ recipeId: 'jus', targetPorsi: 800, kategoriPorsiList: ['PORSI_BESAR'] }] },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].targetPorsi).toBe(2000);
    expect(lines[0].kategoriPorsiList).toEqual(['PORSI_BESAR', 'PORSI_KECIL']);
    expect(mergeKategoriPorsiLists([['PORSI_KECIL'], ['PORSI_BESAR']])).toEqual([
      'PORSI_BESAR',
      'PORSI_KECIL',
    ]);
    expect(mergeRecipeBufferPct([{ a: 3 }, { a: 5, b: 3 }])).toEqual({ a: 5, b: 3 });
  });

  it('assertConsolidatePlans: same kitchen+date, allow APPROVED, reject PROCESSING', () => {
    const base = { tanggal: '2026-08-16', kitchenId: 'k1' };
    expect(assertConsolidatePlans([
      { ...base, id: '1', noDokumen: 'RPN1', status: 'DRAFT' },
    ])).toEqual({ error: expect.stringMatching(/minimal 2/i) });

    expect(assertConsolidatePlans([
      { ...base, id: '1', noDokumen: 'RPN1', status: 'DRAFT' },
      { ...base, id: '2', noDokumen: 'RPN2', status: 'APPROVED' },
    ])).toEqual({ tanggal: '2026-08-16', kitchenId: 'k1', ids: ['1', '2'] });

    expect(assertConsolidatePlans([
      { ...base, id: '1', status: 'DRAFT' },
      { id: '2', tanggal: '2026-08-17', kitchenId: 'k1', status: 'DRAFT' },
    ])).toEqual({ error: expect.stringMatching(/tanggal/i) });

    expect(assertConsolidatePlans([
      { ...base, id: '1', status: 'DRAFT' },
      { id: '2', tanggal: '2026-08-16', kitchenId: 'k2', status: 'DRAFT' },
    ])).toEqual({ error: expect.stringMatching(/dapur/i) });

    expect(assertConsolidatePlans([
      { ...base, id: '1', noDokumen: 'RPN1', status: 'DRAFT' },
      { ...base, id: '2', noDokumen: 'RPN2', status: 'PROCESSING' },
    ])).toEqual({ error: expect.stringMatching(/diproses/i) });

    expect(assertConsolidatePlans([
      { ...base, id: '1', noDokumen: 'RPN1', status: 'COMPLETED' },
      { ...base, id: '2', noDokumen: 'RPN2', status: 'DRAFT' },
    ])).toEqual({ error: expect.stringMatching(/selesai/i) });

    expect(consolidateBlockedReason('APPROVED')).toBeNull();
    expect(consolidateBlockedReason('PROCESSING')).toMatch(/diproses/i);
  });
});
