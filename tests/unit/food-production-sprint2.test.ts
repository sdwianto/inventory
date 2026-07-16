import { describe, expect, it } from 'vitest';
import { normalizeRecipeLines } from '@/lib/food-production/recipe';
import { normalizeMenuItems } from '@/lib/food-production/menu';
import { ITEM_ROLES_UI } from '@/lib/food-production/item-role';

describe('food-production sprint 2', () => {
  it('hides SEMI_FINISHED from UI role list', () => {
    expect(ITEM_ROLES_UI).not.toContain('SEMI_FINISHED');
    expect(ITEM_ROLES_UI).toContain('INGREDIENT');
    expect(ITEM_ROLES_UI).toContain('FINISHED_GOOD');
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
      { productId: 'p1', qty: 2.5, satuan: 'KG', notes: 'beri', productKode: undefined, productNama: undefined, uomId: undefined },
    ]);
  });

  it('rejects duplicate ingredients and FG-as-line', () => {
    expect(normalizeRecipeLines([
      { productId: 'p1', qty: 1 },
      { productId: 'p1', qty: 2 },
    ])).toEqual({ error: expect.stringMatching(/duplikat/i) });

    expect(normalizeRecipeLines(
      [{ productId: 'fg1', qty: 1 }],
      { finishedGoodProductId: 'fg1' },
    )).toEqual({ error: expect.stringMatching(/barang jadi/i) });
  });

  it('validates menu items and rejects duplicates', () => {
    expect(normalizeMenuItems([])).toEqual({ error: expect.stringMatching(/minimal 1/i) });
    expect(normalizeMenuItems([
      { recipeId: 'r1', porsi: 1 },
      { recipeId: 'r1', porsi: 2 },
    ])).toEqual({ error: expect.stringMatching(/duplikat/i) });
    const ok = normalizeMenuItems([{ recipeId: 'r1', porsi: 2 }]);
    expect(ok).toEqual([
      { recipeId: 'r1', porsi: 2, recipeKode: undefined, recipeNama: undefined },
    ]);
  });
});
