import { describe, it, expect } from 'vitest';
import {
  convertRecipeLineQtys,
  defaultKitchenSatuan,
  factorKitchenToBase,
  kitchenSatuanOptionsForBase,
  recipeBaseQtyForFamily,
  recipeUomFamily,
  toBaseRecipeQty,
} from '@/lib/food-production/recipe-uom';
import { PRODUCT_LIST_PROJECTION } from '@/lib/api/product-query';

describe('recipe-uom — keluarga satuan', () => {
  it('mengenali massa, volume, hitung', () => {
    expect(recipeUomFamily('GR')).toBe('MASS');
    expect(recipeUomFamily('kg')).toBe('MASS');
    expect(recipeUomFamily('ONS')).toBe('MASS');
    expect(recipeUomFamily('ML')).toBe('VOLUME');
    expect(recipeUomFamily('LITER')).toBe('VOLUME');
    expect(recipeUomFamily('PCS')).toBe('COUNT');
    expect(recipeUomFamily('SAK')).toBe('COUNT');
    expect(recipeUomFamily('XYZ')).toBe('UNKNOWN');
  });
});

describe('recipe-uom — konversi SI massa/volume', () => {
  it('GR → KG = 0.001', () => {
    const r = toBaseRecipeQty(300, 'GR', { satuan: 'KG' });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.factorToBase).toBeCloseTo(0.001);
    expect(r.qtyBase).toBeCloseTo(0.3);
    expect(r.baseSatuan).toBe('KG');
  });

  it('ONS → KG = 0.1', () => {
    const r = toBaseRecipeQty(16.6, 'ONS', { satuan: 'KG' });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.qtyBase).toBeCloseTo(1.66);
  });

  it('KG → KG identity', () => {
    const r = toBaseRecipeQty(12, 'KG', { satuan: 'KG' });
    expect(r).toMatchObject({ factorToBase: 1, qtyBase: 12, baseSatuan: 'KG' });
  });

  it('ML → L = 0.001', () => {
    const r = toBaseRecipeQty(500, 'ML', { satuan: 'L' });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.qtyBase).toBeCloseTo(0.5);
  });

  it('KG → GR (kebalikan SI)', () => {
    const r = toBaseRecipeQty(0.3, 'KG', { satuan: 'GR' });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.qtyBase).toBeCloseTo(300);
  });
});

describe('recipe-uom — tolak lintas dimensi', () => {
  it('GR → L ditolak', () => {
    expect(factorKitchenToBase('GR', { satuan: 'L' })).toEqual({
      error: expect.stringMatching(/lintas dimensi/i),
    });
  });

  it('ML → KG ditolak', () => {
    expect(toBaseRecipeQty(100, 'ML', { satuan: 'KG' })).toEqual({
      error: expect.stringMatching(/lintas dimensi/i),
    });
  });
});

describe('recipe-uom — kemasan / count base', () => {
  it('GR → SAK memakai recipeBaseGrams', () => {
    // 1 SAK = 25000 GR → 5000 GR = 0.2 SAK
    const r = toBaseRecipeQty(5000, 'GR', { satuan: 'SAK', recipeBaseGrams: 25000 });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.qtyBase).toBeCloseTo(0.2);
  });

  it('GR → BTL memakai nutrition.gramsPerUnit', () => {
    const r = toBaseRecipeQty(350, 'GR', {
      satuan: 'BTL',
      nutrition: { gramsPerUnit: 700 },
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.qtyBase).toBeCloseTo(0.5);
  });

  it('GR → SAK tanpa faktor ditolak (tidak menebak)', () => {
    expect(toBaseRecipeQty(100, 'GR', { satuan: 'SAK' })).toEqual({
      error: expect.stringMatching(/recipeBaseGrams/i),
    });
  });

  it('ML → BTL memakai recipeBaseMl', () => {
    const r = toBaseRecipeQty(250, 'ML', { satuan: 'BTL', recipeBaseMl: 500 });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.qtyBase).toBeCloseTo(0.5);
  });
});

describe('recipe-uom — opsi & default dapur', () => {
  it('base KG → opsi massa, default GR', () => {
    expect(kitchenSatuanOptionsForBase('KG')).toEqual(
      expect.arrayContaining(['KG', 'GR', 'ONS']),
    );
    expect(defaultKitchenSatuan('KG')).toBe('GR');
  });

  it('base SAK tanpa faktor → hanya SAK', () => {
    expect(kitchenSatuanOptionsForBase('SAK')).toEqual(['SAK']);
    expect(defaultKitchenSatuan('SAK')).toBe('SAK');
  });

  it('base SAK + recipeBaseGrams → boleh GR', () => {
    expect(kitchenSatuanOptionsForBase('SAK', { recipeBaseGrams: 25000 })).toEqual(
      expect.arrayContaining(['SAK', 'GR', 'KG']),
    );
    expect(defaultKitchenSatuan('SAK', { recipeBaseGrams: 25000 })).toBe('GR');
  });

  it('base BTL + recipeBaseGrams → GR default (semua kemasan COUNT)', () => {
    expect(kitchenSatuanOptionsForBase('BTL', { recipeBaseGrams: 150 })).toEqual(
      expect.arrayContaining(['BTL', 'GR', 'ONS', 'KG']),
    );
    expect(defaultKitchenSatuan('BTL', { recipeBaseGrams: 150 })).toBe('GR');
  });

  it('base PCS + recipeBaseMl → ML default', () => {
    expect(kitchenSatuanOptionsForBase('PCS', { recipeBaseMl: 600 })).toEqual(
      expect.arrayContaining(['PCS', 'ML', 'L']),
    );
    expect(defaultKitchenSatuan('PCS', { recipeBaseMl: 600 })).toBe('ML');
  });
});

describe('recipe-uom — dual qty + legacy helper', () => {
  it('convertRecipeLineQtys mengisi qtyBase besar & kecil', () => {
    const r = convertRecipeLineQtys({
      qtyBesar: 1000,
      qtyKecil: 700,
      kitchenSatuan: 'GR',
      product: { satuan: 'KG' },
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.qtyBaseBesar).toBeCloseTo(1);
    expect(r.qtyBaseKecil).toBeCloseTo(0.7);
    expect(r.factorToBase).toBeCloseTo(0.001);
    expect(r.baseSatuan).toBe('KG');
    expect(r.satuan).toBe('GR');
  });

  it('recipeBaseQtyForFamily prefer qtyBase*', () => {
    expect(recipeBaseQtyForFamily({
      qtyBesar: 300,
      qtyBaseBesar: 0.3,
      satuan: 'GR',
    } as never, 'BESAR')).toBe(0.3);
  });

  it('recipeBaseQtyForFamily legacy tanpa qtyBase = qty dapur', () => {
    expect(recipeBaseQtyForFamily({ qtyBesar: 12, satuan: 'KG' } as never, 'BESAR')).toBe(12);
  });

  it('recipeBaseQtyForFamily KECIL derive dari pctKecil × factor', () => {
    expect(recipeBaseQtyForFamily({
      qtyBesar: 1000,
      pctKecil: 70,
      factorToBase: 0.001,
      satuan: 'GR',
    } as never, 'KECIL')).toBeCloseTo(0.7);
  });
});

describe('PRODUCT_LIST_PROJECTION — recipe bridge', () => {
  it('exposes recipeBaseGrams/Ml so COUNT products can pick GR/ML in recipe UI', () => {
    expect(PRODUCT_LIST_PROJECTION).toMatchObject({
      satuan: 1,
      recipeBaseGrams: 1,
      recipeBaseMl: 1,
      nutrition: 1,
    });
  });
});

describe('recipe-uom — infer nama + COUNT extra labels', () => {
  it('PCS + nama 1kg tanpa field master → opsi GR, default GR, 100 GR = 0.1 PCS', () => {
    const opts = { nama: 'Abon Sapi Cap Kupu 1kg' };
    expect(kitchenSatuanOptionsForBase('PCS', opts)).toEqual(
      expect.arrayContaining(['PCS', 'GR', 'ONS', 'KG']),
    );
    expect(defaultKitchenSatuan('PCS', opts)).toBe('GR');
    const r = toBaseRecipeQty(100, 'GR', { satuan: 'PCS', nama: 'Abon Sapi Cap Kupu 1kg' });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.qtyBase).toBeCloseTo(0.1);
  });

  it('JRG + recipeBaseMl → COUNT, default ML', () => {
    expect(recipeUomFamily('JRG')).toBe('COUNT');
    expect(recipeUomFamily('ROL')).toBe('COUNT');
    expect(recipeUomFamily('BAL')).toBe('COUNT');
    expect(recipeUomFamily('BALL')).toBe('COUNT');
    expect(defaultKitchenSatuan('JRG', { recipeBaseMl: 5700 })).toBe('ML');
    const r = toBaseRecipeQty(570, 'ML', { satuan: 'JRG', recipeBaseMl: 5700 });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.qtyBase).toBeCloseTo(0.1);
  });

  it('skip operasional: nama 1kg tidak membuka GR', () => {
    expect(kitchenSatuanOptionsForBase('PCS', { kode: 'B189497', nama: 'Barang 1kg' })).toEqual(['PCS']);
    expect(defaultKitchenSatuan('PCS', { kode: 'B189497', nama: 'Barang 1kg' })).toBe('PCS');
  });
});
