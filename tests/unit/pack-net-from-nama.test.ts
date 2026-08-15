import { describe, it, expect } from 'vitest';
import { parsePackNetFromNama, shouldSkipRecipeNameInfer } from '@/lib/food-production/pack-net-from-nama';
import { reviewRecipeBridge } from '@/lib/food-production/recipe-uom';

describe('parsePackNetFromNama', () => {
  it('1kg / 1 kg → 1000 GR', () => {
    expect(parsePackNetFromNama('Abon Sapi Cap Kupu 1kg')).toEqual({ grams: 1000, ml: null });
    expect(parsePackNetFromNama('Baking Soda 1 kg')).toEqual({ grams: 1000, ml: null });
  });

  it('150g / 150gr → 150 GR', () => {
    expect(parsePackNetFromNama('Cuka Apel 150g')).toEqual({ grams: 150, ml: null });
    expect(parsePackNetFromNama('Cuka Apel 150gr')).toEqual({ grams: 150, ml: null });
  });

  it('600ml → 600 ML', () => {
    expect(parsePackNetFromNama('Delmonte Saus Tomat 600ml')).toEqual({ grams: null, ml: 600 });
  });

  it('5,7L / 5.7L → 5700 ML', () => {
    expect(parsePackNetFromNama('Minyak Goreng 5,7L')).toEqual({ grams: null, ml: 5700 });
    expect(parsePackNetFromNama('Minyak Goreng 5.7L')).toEqual({ grams: null, ml: 5700 });
  });

  it('1/2kg → 500 GR (bukan 2000)', () => {
    expect(parsePackNetFromNama('Joyoboyo Plastik 1/2kg')).toEqual({ grams: 500, ml: null });
    expect(parsePackNetFromNama('Plastik 1/2 kg')).toEqual({ grams: 500, ml: null });
  });

  it('nama tanpa isi netto → none', () => {
    expect(parsePackNetFromNama('Garam Dapur')).toEqual({ grams: null, ml: null });
    expect(parsePackNetFromNama('')).toEqual({ grams: null, ml: null });
  });

  it('massa + volume di nama yang sama → ambigu / none', () => {
    expect(parsePackNetFromNama('Campuran 1kg 500ml')).toEqual({ grams: null, ml: null });
  });

  it('dua nilai massa berbeda → ambigu / none', () => {
    expect(parsePackNetFromNama('Paket 1kg dan 500g')).toEqual({ grams: null, ml: null });
  });
});

describe('reviewRecipeBridge — master menang', () => {
  it('field master terisi → factorSource master, ignore infer', () => {
    const r = reviewRecipeBridge({
      nama: 'Cuka Apel 150g',
      satuan: 'BTL',
      recipeBaseGrams: 150,
    });
    expect(r.factorSource).toBe('master');
    expect(r.inferredGrams).toBe(150);
    expect(r.proposedKitchenDefault).toBe('GR');
  });

  it('master kosong + 1kg di nama + PCS → inferred GR', () => {
    const r = reviewRecipeBridge({
      nama: 'Abon Sapi Cap Kupu 1kg',
      satuan: 'PCS',
    });
    expect(r.factorSource).toBe('inferred');
    expect(r.inferredGrams).toBe(1000);
    expect(r.proposedKitchenDefault).toBe('GR');
  });

  it('master kosong tanpa pola → none, default = satuan basis', () => {
    const r = reviewRecipeBridge({ nama: 'Telur Ayam', satuan: 'PCS' });
    expect(r.factorSource).toBe('none');
    expect(r.proposedKitchenDefault).toBe('PCS');
  });

  it('Joyoboyo plastik: parse 500g tapi skip infer (bukan resep)', () => {
    expect(shouldSkipRecipeNameInfer(undefined, 'Joyoboyo Plastik 1/2kg')).toBe(true);
    const r = reviewRecipeBridge({
      nama: 'Joyoboyo Plastik 1/2kg',
      satuan: 'PCS',
    });
    expect(r.inferredGrams).toBe(500);
    expect(r.factorSource).toBe('none');
    expect(r.proposedKitchenDefault).toBe('PCS');
  });

  it('kode operasional skip infer', () => {
    const r = reviewRecipeBridge({
      kode: 'B189497',
      nama: 'Barang 1kg',
      satuan: 'PCS',
    });
    expect(r.factorSource).toBe('none');
    expect(r.proposedKitchenDefault).toBe('PCS');
  });
});
