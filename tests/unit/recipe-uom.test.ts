import { describe, it, expect } from 'vitest';
import {
  convertQtySameFamily,
  convertRecipeLineQtys,
  defaultKitchenSatuan,
  factorKitchenToBase,
  foldSameFamilyQtyLines,
  kitchenSatuanOptionsForBase,
  pickCanonicalSatuan,
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
    expect(recipeUomFamily('RTG')).toBe('COUNT');
    expect(recipeUomFamily('RENTENG')).toBe('COUNT');
    expect(recipeUomFamily('XYZ')).toBe('UNKNOWN');
  });
});

describe('recipe-uom — fold satuan sefamili (semua kode)', () => {
  it('mengkonversi GR ↔ KG dan ML ↔ L', () => {
    expect(convertQtySameFamily(1369, 'GR', 'KG')).toBeCloseTo(1.369);
    expect(convertQtySameFamily(1.369, 'KG', 'GR')).toBeCloseTo(1369);
    expect(convertQtySameFamily(500, 'ML', 'L')).toBeCloseTo(0.5);
    expect(convertQtySameFamily(10, 'GR', 'PCS')).toBeNull();
  });

  it('pilih KG jika ada campuran GR/KG; utamakan satuan stok sefamili', () => {
    expect(pickCanonicalSatuan(['GR', 'KG'])).toBe('KG');
    expect(pickCanonicalSatuan(['ML', 'L'])).toBe('L');
    expect(pickCanonicalSatuan(['GR', 'KG'], 'GR')).toBe('GR');
    expect(pickCanonicalSatuan(['GR', 'PCS'])).toBeNull();
  });

  it('gabung Gula Pasir-like 1.369 GR + 9.125 KG jadi satu KG untuk kode mana pun', () => {
    const folded = foldSameFamilyQtyLines(
      [
        { productKode: 'B387463', productId: 'a', satuan: 'GR', qty: 1.369 },
        { productKode: 'B387463', productId: 'b', satuan: 'KG', qty: 9.125 },
        { productKode: 'B999', productId: 'c', satuan: 'GR', qty: 10 },
        { productKode: 'B999', productId: 'c', satuan: 'PCS', qty: 2 },
      ],
      (r) => r.qty,
      (r, qty, satuan) => ({ ...r, qty, satuan }),
      (a, b) => ({ ...a, qty: a.qty + b.qty }),
    );
    const gula = folded.find((r) => r.productKode === 'B387463');
    expect(gula?.satuan).toBe('KG');
    expect(gula?.qty).toBeCloseTo(9.126369, 6);
    expect(folded.filter((r) => r.productKode === 'B999')).toHaveLength(2);
  });

  it('ONS + KG → satu KG; KILOGRAM alias; LITER + ML → L', () => {
    const mass = foldSameFamilyQtyLines(
      [
        { productKode: 'X', satuan: 'ONS', qty: 16.6 },
        { productKode: 'X', satuan: 'KG', qty: 1 },
      ],
      (r) => r.qty,
      (r, qty, satuan) => ({ ...r, qty, satuan }),
      (a, b) => ({ ...a, qty: a.qty + b.qty }),
    );
    expect(mass).toHaveLength(1);
    expect(mass[0].satuan).toBe('KG');
    expect(mass[0].qty).toBeCloseTo(2.66);

    const alias = foldSameFamilyQtyLines(
      [
        { productKode: 'Y', satuan: 'KILOGRAM', qty: 2 },
        { productKode: 'Y', satuan: 'KG', qty: 0.5 },
      ],
      (r) => r.qty,
      (r, qty, satuan) => ({ ...r, qty, satuan }),
      (a, b) => ({ ...a, qty: a.qty + b.qty }),
    );
    expect(alias).toHaveLength(1);
    expect(alias[0].satuan).toBe('KG');
    expect(alias[0].qty).toBeCloseTo(2.5);

    const vol = foldSameFamilyQtyLines(
      [
        { productKode: 'Z', satuan: 'ML', qty: 250 },
        { productKode: 'Z', satuan: 'LITER', qty: 1 },
      ],
      (r) => r.qty,
      (r, qty, satuan) => ({ ...r, qty, satuan }),
      (a, b) => ({ ...a, qty: a.qty + b.qty }),
    );
    expect(vol).toHaveLength(1);
    expect(vol[0].satuan).toBe('LITER');
    expect(vol[0].qty).toBeCloseTo(1.25);
  });

  it('utamakan satuan stok preferredBase meski ada satuan lebih besar', () => {
    const folded = foldSameFamilyQtyLines(
      [
        { productKode: 'W', satuan: 'GR', qty: 500, baseSatuan: 'GR' },
        { productKode: 'W', satuan: 'KG', qty: 1, baseSatuan: 'GR' },
      ],
      (r) => r.qty,
      (r, qty, satuan) => ({ ...r, qty, satuan }),
      (a, b) => ({ ...a, qty: a.qty + b.qty }),
      (r) => r.baseSatuan,
    );
    expect(folded).toHaveLength(1);
    expect(folded[0].satuan).toBe('GR');
    expect(folded[0].qty).toBeCloseTo(1500);
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

  it('Minyak Sunco Refil 2L + TKPI gramsPerUnit 100 → 500 ML = 0,25 PCS', () => {
    const product = {
      satuan: 'PCS',
      nama: 'Minyak Sunco Refil 2L',
      nutrition: { gramsPerUnit: 100 },
    };
    expect(kitchenSatuanOptionsForBase('PCS', {
      nama: product.nama,
      gramsPerUnit: 100,
    })).toEqual(expect.arrayContaining(['PCS', 'ML', 'L']));
    expect(defaultKitchenSatuan('PCS', {
      nama: product.nama,
      gramsPerUnit: 100,
    })).toBe('ML');

    const r = toBaseRecipeQty(500, 'ML', product);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.qtyBase).toBeCloseTo(0.25);
    expect(r.baseSatuan).toBe('PCS');
  });
});

describe('recipe-uom — opsi & default dapur', () => {
  it('base KG → opsi massa, default GR', () => {
    expect(kitchenSatuanOptionsForBase('KG')).toEqual(
      expect.arrayContaining(['KG', 'GR', 'ONS']),
    );
    expect(defaultKitchenSatuan('KG')).toBe('GR');
  });

  it('Kaldu RTG + recipeBaseGrams izinkan GR (resep lama edit/save)', () => {
    const opts = {
      recipeBaseGrams: 12.5,
      nama: 'Kaldu Desaku Marinasi Instan 12,5g',
      kode: 'B511393',
    };
    expect(kitchenSatuanOptionsForBase('RTG', opts)).toEqual(
      expect.arrayContaining(['RTG', 'GR', 'ONS', 'KG']),
    );
    expect(defaultKitchenSatuan('RTG', opts)).toBe('GR');
    const r = toBaseRecipeQty(500, 'GR', { satuan: 'RTG', ...opts });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.qtyBase).toBeCloseTo(40); // 500 / 12.5
    expect(r.baseSatuan).toBe('RTG');
  });

  it('basis UNKNOWN + recipeBaseGrams juga izinkan GR', () => {
    expect(kitchenSatuanOptionsForBase('CRT', { recipeBaseGrams: 200 })).toEqual(
      expect.arrayContaining(['CRT', 'GR']),
    );
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
