import { describe, expect, it } from 'vitest';
import { normalizeRecipeLines } from '@/lib/food-production/recipe';
import { normalizeMenuItems } from '@/lib/food-production/menu';
import {
  ITEM_ROLES_UI,
  isFinishedGoodRole,
  isIngredientRole,
  normalizeItemRole,
} from '@/lib/food-production/item-role';

describe('food-production sprint 2', () => {
  it('hides SEMI_FINISHED from UI role list', () => {
    expect(ITEM_ROLES_UI).not.toContain('SEMI_FINISHED');
    expect(ITEM_ROLES_UI).toContain('INGREDIENT');
    expect(ITEM_ROLES_UI).toContain('FINISHED_GOOD');
  });

  it('classifies finished-good vs ingredient roles (unset → INGREDIENT)', () => {
    expect(normalizeItemRole(undefined)).toBe('INGREDIENT');
    expect(isFinishedGoodRole(undefined)).toBe(false);
    expect(isFinishedGoodRole('INGREDIENT')).toBe(false);
    expect(isFinishedGoodRole('FINISHED_GOOD')).toBe(true);
    expect(isFinishedGoodRole('SEMI_FINISHED')).toBe(true);
    expect(isIngredientRole(undefined)).toBe(true);
    expect(isIngredientRole('INGREDIENT')).toBe(true);
    expect(isIngredientRole('FINISHED_GOOD')).toBe(false);
    expect(isIngredientRole('SEMI_FINISHED')).toBe(true);
  });

  it('accepts RSP-xxxx kode pattern', () => {
    expect(/^RSP-\d{4,}$/.test('RSP-0001')).toBe(true);
    expect(/^RSP-\d{4,}$/.test('RSP-12')).toBe(false);
    expect(/^RSP-\d{4,}$/.test('RSP-NASI-GORENG-')).toBe(false);
  });

  it('validates recipe lines', () => {
    expect(normalizeRecipeLines([])).toEqual({ error: expect.stringMatching(/minimal 1/i) });
    expect(normalizeRecipeLines([{ productId: '', qty: 1 }])).toEqual({
      error: expect.stringMatching(/productId/i),
    });
    expect(normalizeRecipeLines([{ productId: 'p1', qty: 0 }])).toEqual({
      error: expect.stringMatching(/qty/i),
    });
    const ok = normalizeRecipeLines([
      { productId: 'p1', qty: 2.5, satuan: 'KG', notes: 'beri' },
    ]);
    expect(ok).toEqual([
      {
        productId: 'p1',
        qty: 2.5,
        qtyBesar: 2.5,
        pctKecil: 70,
        qtyKecil: 1.75,
        satuan: 'KG',
        notes: 'beri',
        productKode: undefined,
        productNama: undefined,
        uomId: undefined,
      },
    ]);
    const withPct = normalizeRecipeLines([
      { productId: 'p1', qtyBesar: 10, pctKecil: 50 },
    ]);
    expect(withPct).toEqual([
      expect.objectContaining({
        productId: 'p1',
        qty: 10,
        qtyBesar: 10,
        pctKecil: 50,
        qtyKecil: 5,
      }),
    ]);
  });

  it('consolidates duplicate ingredients and rejects FG-as-line', () => {
    const merged = normalizeRecipeLines([
      { productId: 'p1', qty: 1 },
      { productId: 'p1', qty: 2 },
    ]);
    expect(merged).toEqual([
      expect.objectContaining({ productId: 'p1', qty: 3, qtyBesar: 3, pctKecil: 70, qtyKecil: 2.1 }),
    ]);

    expect(normalizeRecipeLines(
      [{ productId: 'fg1', qty: 1 }],
      { finishedGoodProductId: 'fg1' },
    )).toEqual({ error: expect.stringMatching(/barang jadi/i) });
  });

  it('normalizes recipe nama as identity', async () => {
    const { normalizeRecipeNama } = await import('@/lib/food-production/recipe');
    expect(normalizeRecipeNama('  Nasi   Goreng  ')).toBe('Nasi Goreng');
    expect(normalizeRecipeNama('')).toBe('');
  });

  it('validates menu items and consolidates duplicates', () => {
    expect(normalizeMenuItems([])).toEqual({ error: expect.stringMatching(/minimal 1/i) });
    expect(normalizeMenuItems([{ recipeId: 'r1', porsi: 2 }])).toEqual({
      error: expect.stringMatching(/bahan pangan/i),
    });
    const merged = normalizeMenuItems([
      { recipeId: 'r1', bahanPangan: 'SAYUR', porsi: 1 },
      { recipeId: 'r1', bahanPangan: 'SAYUR', porsi: 2 },
    ]);
    expect(merged).toEqual([
      expect.objectContaining({ recipeId: 'r1', bahanPangan: 'SAYUR', porsi: 3 }),
    ]);
    const split = normalizeMenuItems([
      { recipeId: 'r1', bahanPangan: 'SAYUR', porsi: 1 },
      { recipeId: 'r1', bahanPangan: 'BUAH', porsi: 2 },
    ]);
    expect(split).toEqual([
      expect.objectContaining({ recipeId: 'r1', bahanPangan: 'SAYUR', porsi: 1 }),
      expect.objectContaining({ recipeId: 'r1', bahanPangan: 'BUAH', porsi: 2 }),
    ]);
    const ok = normalizeMenuItems([{ recipeId: 'r1', bahanPangan: 'SUSU', porsi: 2 }]);
    expect(ok).toEqual([
      {
        recipeId: 'r1',
        bahanPangan: 'SUSU',
        porsi: 2,
        recipeKode: undefined,
        recipeNama: undefined,
      },
    ]);
  });
});

