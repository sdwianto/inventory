import { describe, it, expect } from 'vitest';
import {
  collectRecipeProductIds,
  mergeProductCache,
  missingProductIds,
} from '@/lib/food-production/recipe-product-cache';
import { kitchenSatuanOptionsForBase } from '@/lib/food-production/recipe-uom';

type ProductOpt = {
  id: string;
  nama: string;
  satuan?: string;
  tkpiCode?: string;
  recipeBaseGrams?: number;
};

function kitchenOptsForProduct(p: ProductOpt | undefined): string[] {
  if (!p?.satuan) return [];
  return kitchenSatuanOptionsForBase(p.satuan, {
    recipeBaseGrams: p.recipeBaseGrams,
    nama: p.nama,
  });
}

const wortel: ProductOpt = {
  id: 'prod-wortel-super',
  nama: 'Wortel Super',
  satuan: 'ONS',
  tkpiCode: 'WR001',
};

const first200: ProductOpt[] = Array.from({ length: 200 }, (_, i) => ({
  id: `prod-${String(i).padStart(3, '0')}`,
  nama: `Bahan ${i}`,
  satuan: 'KG',
}));

describe('recipe product cache — hydrate di luar limit 200', () => {
  it('collectRecipeProductIds mengambil id dari form + baris resep tersimpan', () => {
    const ids = collectRecipeProductIds(
      [{ productId: 'a' }, { productId: 'a' }, { productId: '' }],
      [{ lines: [{ productId: 'b' }, { productId: wortel.id }] }],
    );
    expect(ids).toEqual(['a', 'b', wortel.id]);
  });

  it('missingProductIds hanya id yang belum di cache', () => {
    expect(missingProductIds(['a', wortel.id, 'a'], [{ id: 'a' }])).toEqual([wortel.id]);
  });

  it('load 200 tidak menimpa Wortel yang sudah di-pick/hydrate', () => {
    const afterLoad = mergeProductCache([wortel], first200);
    const found = afterLoad.find((p) => p.id === wortel.id);
    expect(found).toEqual(wortel);
    expect(found?.tkpiCode).toBe('WR001');
    expect(kitchenOptsForProduct(found)).toEqual(['ONS', 'GR', 'KG']);
  });

  it('hydrate by id mengisi Wortel yang tidak masuk GET /products?limit=200', () => {
    const needed = collectRecipeProductIds([{ productId: wortel.id }], []);
    expect(missingProductIds(needed, first200)).toEqual([wortel.id]);

    const afterHydrate = mergeProductCache(first200, [wortel]);
    const found = afterHydrate.find((p) => p.id === wortel.id);
    expect(found?.tkpiCode).toBe('WR001');
    expect(kitchenOptsForProduct(found)).toEqual(['ONS', 'GR', 'KG']);
  });
});
