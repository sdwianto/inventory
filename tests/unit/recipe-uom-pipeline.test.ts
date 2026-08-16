/**
 * Bukti aktual rantai: konversi dapur → enrich snapshot → MRP → rencana → cost → gizi.
 * Bukan stub — memanggil fungsi produksi yang sama dipakai handler/UI.
 */
import { describe, expect, it } from 'vitest';
import {
  convertRecipeLineQtys,
  defaultKitchenSatuan,
  factorKitchenToBase,
  kitchenSatuanOptionsForBase,
  toBaseRecipeQty,
} from '@/lib/food-production/recipe-uom';
import { computeRecipeLineContributions } from '@/lib/food-production/material-requirement';
import { recipeIngredientNeeds } from '@/lib/food-production/rencana-kebutuhan';
import { analyzeRecipeStandardCost } from '@/lib/food-production/cost';
import { analyzeRecipeNutrition } from '@/lib/food-production/nutrition';
import type { RecipeLine } from '@/lib/food-production/recipe';

/** Simulasi enrichLines (tanpa DB) — logika konversi sama dengan handlers/recipes.ts */
function enrichLineLike(
  line: Pick<RecipeLine, 'productId' | 'qtyBesar' | 'qtyKecil' | 'pctKecil' | 'qty' | 'satuan'>,
  product: {
    satuan?: string;
    recipeBaseGrams?: number;
    recipeBaseMl?: number;
    nutrition?: { gramsPerUnit?: number };
    kode?: string;
    nama?: string;
  },
): RecipeLine | { error: string } {
  const baseSatuan = String(product.satuan || '').trim().toUpperCase();
  const allowed = kitchenSatuanOptionsForBase(baseSatuan, {
    recipeBaseGrams: product.recipeBaseGrams,
    recipeBaseMl: product.recipeBaseMl,
    gramsPerUnit: product.nutrition?.gramsPerUnit,
  });
  let kitchen = String(line.satuan || '').trim().toUpperCase();
  if (!kitchen) {
    kitchen = defaultKitchenSatuan(baseSatuan, {
      recipeBaseGrams: product.recipeBaseGrams,
      recipeBaseMl: product.recipeBaseMl,
      gramsPerUnit: product.nutrition?.gramsPerUnit,
    });
  }
  if (kitchen && allowed.length && !allowed.includes(kitchen)) {
    return { error: `satuan dapur ${kitchen} tidak kompatibel (pilih: ${allowed.join(', ')})` };
  }
  const converted = convertRecipeLineQtys({
    qtyBesar: Number(line.qtyBesar) || 0,
    qtyKecil: Number(line.qtyKecil) || 0,
    kitchenSatuan: kitchen,
    product: {
      satuan: product.satuan,
      recipeBaseGrams: product.recipeBaseGrams,
      recipeBaseMl: product.recipeBaseMl,
      nutrition: product.nutrition,
    },
  });
  if ('error' in converted) return converted;
  return {
    productId: line.productId,
    productKode: product.kode,
    productNama: product.nama,
    qty: Number(line.qtyBesar) || 0,
    qtyBesar: Number(line.qtyBesar) || 0,
    pctKecil: Number(line.pctKecil) || 70,
    qtyKecil: Number(line.qtyKecil) || 0,
    satuan: converted.satuan,
    qtyBaseBesar: converted.qtyBaseBesar,
    qtyBaseKecil: converted.qtyBaseKecil,
    factorToBase: converted.factorToBase,
    baseSatuan: converted.baseSatuan,
  };
}

describe('recipe-uom pipeline (aktual)', () => {
  it('MBG-like: 300 GR ayam → 0.3 KG di MRP/cost/gizi, display tetap GR', () => {
    const enriched = enrichLineLike(
      {
        productId: 'ayam',
        qty: 300,
        qtyBesar: 300,
        pctKecil: 70,
        qtyKecil: 210,
        satuan: 'GR',
      },
      { satuan: 'KG', kode: 'AYAM', nama: 'Ayam' },
    );
    expect('error' in enriched).toBe(false);
    if ('error' in enriched) return;

    expect(enriched.satuan).toBe('GR');
    expect(enriched.qtyBaseBesar).toBeCloseTo(0.3);
    expect(enriched.qtyBaseKecil).toBeCloseTo(0.21);
    expect(enriched.factorToBase).toBeCloseTo(0.001);
    expect(enriched.baseSatuan).toBe('KG');

    const contrib = computeRecipeLineContributions({
      recipe: { id: 'r1', yieldQty: 100, wastePct: 0, lines: [enriched] },
      recipeFactor: 1,
      porsiBesar: 200,
      porsiKecil: 0,
      excludedKeys: new Set(),
      overrideQtyByKey: new Map(),
    });
    expect(contrib).toHaveLength(1);
    expect(contrib[0].qty).toBeCloseTo(0.6); // 200/100 * 0.3
    expect(contrib[0].satuan).toBe('KG');

    const needs = recipeIngredientNeeds({
      recipe: { yieldQty: 100, wastePct: 0, lines: [enriched] },
      menuTargetPorsi: 100,
      recipePerMenuPorsi: 1,
      kategoriPorsiList: ['PORSI_BESAR'],
    });
    expect(needs[0].qty).toBe(300);
    expect(needs[0].satuan).toBe('GR');

    const cost = analyzeRecipeStandardCost({
      recipe: {
        id: 'r1', kode: 'RSP-1', nama: 'Ayam Kare', yieldQty: 100, wastePct: 0, lines: [enriched],
      },
      productsById: new Map([['ayam', { productId: 'ayam', hargaBeli: 50000, satuan: 'KG' }]]),
    });
    expect(cost.lines[0].qty).toBeCloseTo(0.3);
    expect(cost.lines[0].satuan).toBe('KG');
    expect(cost.lines[0].amount).toBe(15000);

    const nut = analyzeRecipeNutrition({
      recipe: {
        id: 'r1', kode: 'RSP-1', nama: 'Ayam Kare', yieldQty: 100, lines: [enriched],
      },
      productsById: new Map([['ayam', {
        productId: 'ayam',
        satuan: 'KG',
        nutrition: {
          basis: 'PER_100G',
          gramsPerUnit: 1000,
          energiKcal: 120,
          proteinG: 20,
          lemakG: 5,
          karbohidratG: 0,
        },
      }]]),
    });
    // 0.3 KG × 1000 g × 120/100 = 360 — BUKAN 300×1000×1.2 = 360000
    expect(nut.batch.energiKcal).toBe(360);
    expect(nut.lines[0].qty).toBe(300);
    expect(nut.lines[0].satuan).toBe('GR');
  });

  it('SAK dengan recipeBaseGrams: 5000 GR → 0.2 SAK; tanpa faktor ditolak', () => {
    const ok = enrichLineLike(
      { productId: 'gula', qty: 5000, qtyBesar: 5000, pctKecil: 70, qtyKecil: 3500, satuan: 'GR' },
      { satuan: 'SAK', recipeBaseGrams: 25000, nama: 'Gula' },
    );
    expect('error' in ok).toBe(false);
    if ('error' in ok) return;
    expect(ok.qtyBaseBesar).toBeCloseTo(0.2);
    expect(ok.baseSatuan).toBe('SAK');

    const bad = enrichLineLike(
      { productId: 'gula', qty: 100, qtyBesar: 100, pctKecil: 70, qtyKecil: 70, satuan: 'GR' },
      { satuan: 'SAK', nama: 'Gula' },
    );
    expect(bad).toEqual({ error: expect.stringMatching(/recipeBaseGrams|tidak kompatibel/i) });
  });

  it('default kosong → GR untuk base KG; opsi SAK tanpa faktor hanya SAK', () => {
    const enriched = enrichLineLike(
      { productId: 'beras', qty: 300, qtyBesar: 300, pctKecil: 70, qtyKecil: 210, satuan: '' },
      { satuan: 'KG', nama: 'Beras' },
    );
    expect('error' in enriched).toBe(false);
    if ('error' in enriched) return;
    expect(enriched.satuan).toBe('GR');
    expect(enriched.qtyBaseBesar).toBeCloseTo(0.3);

    expect(kitchenSatuanOptionsForBase('SAK')).toEqual(['SAK']);
    expect(defaultKitchenSatuan('KG')).toBe('GR');
  });

  it('tolak lintas dimensi aktual', () => {
    expect(factorKitchenToBase('GR', { satuan: 'L' })).toMatchObject({
      error: expect.stringMatching(/lintas dimensi/i),
    });
    expect(toBaseRecipeQty(100, 'ML', { satuan: 'KG' })).toMatchObject({
      error: expect.stringMatching(/lintas dimensi/i),
    });
  });
});
