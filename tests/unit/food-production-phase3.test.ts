import { describe, expect, it } from 'vitest';
import { FP_DOC_PREFIX, FP_DOC_TYPES } from '@/lib/food-production/document';
import {
  normalizeNutritionFacts,
  contributionFromProduct,
  analyzeRecipeNutrition,
  analyzePlanLineNutrition,
  analyzePlanDraftNutrition,
  analyzeResultNutrition,
  resolveProductNutrition,
  resolveAkgKey,
  suggestAkgProfileForCategories,
  AKG_PROFILES,
  AKG_COMPLIANCE_MIN_PCT,
} from '@/lib/food-production/nutrition';
import { resolveTkpiCodeByProductName, suggestTkpiMatches, searchTkpiFoods, tkpiPickerQuery } from '@/lib/food-production/tkpi-catalog';
import { resolveUsdaCodeByProductName, suggestUsdaMatches, searchUsdaFoods, nutritionFromUsdaCode } from '@/lib/food-production/usda-catalog';
import { DEFAULT_PCT_KECIL, computeQtyKecil } from '@/lib/food-production/recipe';
import {
  analyzeRecipeStandardCost,
  analyzeActualCost,
} from '@/lib/food-production/cost';
import {
  assertQcCanComplete,
  summarizeQcItems,
  normalizeQcTemplateItems,
} from '@/lib/food-production/qc';
import { buildMaterialForecast, parseHorizon } from '@/lib/food-production/forecast';
import { buildFoodDashboardTips } from '@/lib/food-production/dashboard';
import {
  buildRecommendations,
  recommendShortages,
  recommendWaste,
  recommendStockOpt,
  recommendSubstitutes,
  recommendMenuAlt,
  recommendCheaperSupply,
  WASTE_ISSUE_OVERAGE_PCT,
} from '@/lib/food-production/recommendations';
import type { ForecastLine } from '@/lib/food-production/forecast';

describe('food-production phase 3', () => {
  it('registers QC doc prefix QCR', () => {
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.QC_RESULT]).toBe('QCR');
  });

  it('normalizes nutrition and computes PER_100G contribution', () => {
    const n = normalizeNutritionFacts({
      basis: 'PER_100G',
      gramsPerUnit: 1000,
      energiKcal: 130,
      proteinG: 2.5,
      lemakG: 0.3,
      karbohidratG: 28,
    });
    expect('error' in (n as object)).toBe(false);
    if ('error' in (n as object)) return;
    const c = contributionFromProduct(1, n); // 1 KG = 1000g → ×10 of per-100g
    expect(c?.energiKcal).toBe(1300);
  });

  it('applies BDD% on PER_100G contribution', () => {
    const n = normalizeNutritionFacts({
      basis: 'PER_100G',
      gramsPerUnit: 100,
      bddPct: 50,
      energiKcal: 200,
      proteinG: 10,
      lemakG: 1,
      karbohidratG: 20,
    });
    expect('error' in (n as object)).toBe(false);
    if ('error' in (n as object)) return;
    const c = contributionFromProduct(1, n); // 100g × 50% BDD → 50g → 0.5× per-100g
    expect(c?.energiKcal).toBe(100);
  });

  it('PER_100G on recipe uses kitchen GR (TKPI/100g), not qtyBase × gramsPerUnit PCS', () => {
    const analyzed = analyzeRecipeNutrition({
      recipe: {
        id: 'r-jus',
        kode: 'RSP-0001',
        nama: 'Jus Buah',
        yieldQty: 1,
        lines: [{
          productId: 'semangka',
          qty: 10,
          qtyBesar: 10,
          satuan: 'GR',
          qtyBaseBesar: 0.01,
          baseSatuan: 'KG',
          factorToBase: 0.001,
          productNama: 'Semangka',
        }],
      },
      productsById: new Map([['semangka', {
        productId: 'semangka',
        productNama: 'Semangka',
        satuan: 'PCS',
        nutrition: {
          basis: 'PER_100G',
          gramsPerUnit: 100,
          bddPct: 100,
          energiKcal: 28,
          proteinG: 0.5,
          lemakG: 0.2,
          karbohidratG: 6.9,
        },
      }]]),
    });
    expect(analyzed.perPorsi.energiKcal).toBeCloseTo(2.8, 1);
    expect(analyzed.missingProductIds).toHaveLength(0);
  });

  it('keeps mapped TKPI lines when one ingredient is missing', () => {
    const analyzed = analyzeRecipeNutrition({
      recipe: {
        id: 'r-jus',
        kode: 'RSP-0001',
        nama: 'Jus Buah',
        yieldQty: 1,
        lines: [
          {
            productId: 'semangka',
            qty: 10,
            qtyBesar: 10,
            satuan: 'GR',
            productNama: 'Semangka',
          },
          {
            productId: 'bumbu-fiktif',
            qty: 1,
            qtyBesar: 1,
            satuan: 'PCS',
            productNama: 'Bumbu Rahasia XYZ',
          },
        ],
      },
      productsById: new Map([['semangka', {
        productId: 'semangka',
        productNama: 'Semangka',
        satuan: 'PCS',
        nutrition: {
          basis: 'PER_100G',
          gramsPerUnit: 100,
          bddPct: 100,
          energiKcal: 28,
          proteinG: 0.5,
          lemakG: 0.2,
          karbohidratG: 6.9,
        },
      }]]),
    });
    expect(analyzed.missingProductIds).toEqual(['bumbu-fiktif']);
    expect(analyzed.perPorsi.energiKcal).toBeCloseTo(2.8, 1);
  });

  it('divides batch TKPI by yieldQty for per-porsi (10 GR / 500 porsi)', () => {
    const analyzed = analyzeRecipeNutrition({
      recipe: {
        id: 'r-jus',
        kode: 'RSP-0001',
        nama: 'Jus Buah',
        yieldQty: 500,
        lines: [{
          productId: 'semangka',
          qty: 10,
          qtyBesar: 10,
          satuan: 'GR',
          qtyBaseBesar: 0.01,
          baseSatuan: 'KG',
          productNama: 'Semangka',
        }],
      },
      productsById: new Map([['semangka', {
        productId: 'semangka',
        productNama: 'Semangka',
        satuan: 'PCS',
        nutrition: {
          basis: 'PER_100G',
          gramsPerUnit: 100,
          bddPct: 100,
          energiKcal: 28,
          proteinG: 0.5,
          lemakG: 0.2,
          karbohidratG: 6.9,
        },
      }]]),
    });
    expect(analyzed.batch.energiKcal).toBeCloseTo(2.8, 1);
    expect(analyzed.perPorsi.energiKcal).toBeCloseTo(2.8 / 500, 2);
  });

  it('resolves nutrition from TKPI alias when products.nutrition empty', () => {
    expect(resolveTkpiCodeByProductName('Bawang Bombay')?.kode).toBe('DR007');
    expect(resolveTkpiCodeByProductName('Telur Ayam Broiler')?.kode).toBe('HR002');
    expect(resolveTkpiCodeByProductName('Beras Pulen')?.kode).toBe('AR001');
    expect(resolveTkpiCodeByProductName('Kangkung')?.kode).toBe('DR100');

    const resolved = resolveProductNutrition({
      productId: 'p1',
      productNama: 'Bawang Bombay',
      satuan: 'KG',
      nutrition: null,
    });
    expect(resolved.source).toBe('alias');
    expect(resolved.tkpiCode).toBe('DR007');
    expect(resolved.nutrition?.energiKcal).toBeGreaterThan(0);

    const analyzed = analyzeRecipeNutrition({
      recipe: {
        id: 'r-gado',
        kode: 'RSP-0001',
        nama: 'Gado gado',
        yieldQty: 100,
        lines: [
          { productId: 'beras', qty: 5, productNama: 'Beras Pulen', satuan: 'KG' },
          { productId: 'telur', qty: 15, productNama: 'Telur Ayam Broiler', satuan: 'KG' },
          { productId: 'bombay', qty: 5, productNama: 'Bawang Bombay', satuan: 'KG' },
          { productId: 'bputih', qty: 4, productNama: 'Bawang Putih Kupas', satuan: 'KG' },
          { productId: 'bmerah', qty: 4, productNama: 'Bawang Merah Kupas', satuan: 'KG' },
          { productId: 'kangkung', qty: 10, productNama: 'Kangkung', satuan: 'PACK' },
        ],
      },
      productsById: new Map([
        ['beras', { productId: 'beras', productNama: 'Beras Pulen', satuan: 'KG', nutrition: null }],
        ['telur', { productId: 'telur', productNama: 'Telur Ayam Broiler', satuan: 'KG', nutrition: null }],
        ['bombay', { productId: 'bombay', productNama: 'Bawang Bombay', satuan: 'KG', nutrition: null }],
        ['bputih', { productId: 'bputih', productNama: 'Bawang Putih Kupas', satuan: 'KG', nutrition: null }],
        ['bmerah', { productId: 'bmerah', productNama: 'Bawang Merah Kupas', satuan: 'KG', nutrition: null }],
        ['kangkung', { productId: 'kangkung', productNama: 'Kangkung', satuan: 'PACK', nutrition: null }],
      ]),
      akgProfile: 'PORSI_KECIL',
    });
    expect(analyzed.missingProductIds).toHaveLength(0);
    expect(analyzed.perPorsi.energiKcal).toBeGreaterThan(0);
    expect(analyzed.warnings.some((w) => /PACK/.test(w))).toBe(true);
  });

  it('suggestTkpiMatches returns top TKPI hits including ties (Apel Fuji, Durian)', () => {
    const apel = suggestTkpiMatches('Apel Fuji Premium', 3);
    expect(apel[0]?.kode).toBe('ER004');
    expect(apel[0]?.nama).toBe('Apel, segar');
    expect(apel[1]?.kode).toBe('ER003');
    expect(apel[1]?.nama).toBe('Apel malang, segar');
    expect(apel.length).toBeGreaterThanOrEqual(2);

    const durian = suggestTkpiMatches('Durian Kupas', 3);
    expect(durian[0]?.kode).toBe('ER023');
    expect(durian[0]?.nama).toBe('Durian, segar');

    expect(suggestTkpiMatches('Kelengkeng', 3)).toEqual([]);
  });

  it('falls back to USDA SR longan when Kelengkeng is missing from TKPI', () => {
    expect(searchUsdaFoods('kelengkeng', 5)[0]?.kode).toBe('USDA-09172');
    expect(suggestUsdaMatches('Kelengkeng', 3)[0]?.kode).toBe('USDA-09172');
    expect(resolveUsdaCodeByProductName('Kelengkeng')?.kode).toBe('USDA-09172');

    const facts = nutritionFromUsdaCode('USDA-09172', 'GR');
    expect(facts?.energiKcal).toBe(60);
    expect(facts?.proteinG).toBeCloseTo(1.31, 2);

    const resolved = resolveProductNutrition({
      productId: 'kelengkeng',
      productNama: 'Kelengkeng',
      satuan: 'PCS',
      nutrition: null,
    });
    expect(resolved.source).toBe('usda');
    expect(resolved.usdaCode).toBe('USDA-09172');
    expect(resolved.nutrition?.energiKcal).toBe(60);
    expect(resolved.warning).toMatch(/USDA/i);

    const analyzed = analyzeRecipeNutrition({
      recipe: {
        id: 'r-jus',
        kode: 'RSP-0001',
        nama: 'Jus Buah',
        yieldQty: 1,
        lines: [{
          productId: 'kelengkeng',
          qty: 10,
          qtyBesar: 10,
          satuan: 'GR',
          productNama: 'Kelengkeng',
        }],
      },
      productsById: new Map([['kelengkeng', {
        productId: 'kelengkeng',
        productNama: 'Kelengkeng',
        satuan: 'PCS',
        nutrition: null,
      }]]),
    });
    expect(analyzed.missingProductIds).toHaveLength(0);
    expect(analyzed.perPorsi.energiKcal).toBeCloseTo(6, 1);
  });

  it('searchTkpiFoods jagung returns many ranked variants for the recipe picker', () => {
    expect(tkpiPickerQuery('Jagung manis')).toBe('jagung');
    expect(tkpiPickerQuery('B175812 Jagung manis')).toBe('jagung');
    const hits = searchTkpiFoods('jagung', 80);
    expect(hits.length).toBeGreaterThan(5);
    expect(hits.some((h) => /jagung muda/i.test(h.nama))).toBe(true);
    expect(hits.some((h) => /tepung jagung|jagung kuning, tepung/i.test(h.nama))).toBe(true);
    expect(hits[0]?.nama.toLowerCase().startsWith('jagung')).toBe(true);
  });

  it('analyzes recipe nutrition per porsi + AKG pct', () => {
    const analyzed = analyzeRecipeNutrition({
      recipe: {
        id: 'r1',
        kode: 'RSP-1',
        nama: 'Nasi',
        yieldQty: 100,
        lines: [{ productId: 'beras', qty: 10, productNama: 'Beras' }],
      },
      productsById: new Map([['beras', {
        productId: 'beras',
        nutrition: {
          basis: 'PER_UNIT',
          energiKcal: 3500,
          proteinG: 70,
          lemakG: 10,
          karbohidratG: 750,
        },
      }]]),
      akgProfile: 'PORSI_KECIL',
    });
    // 10 unit × 3500 kkal / 100 porsi = 350 kkal per porsi
    expect(analyzed.perPorsi.energiKcal).toBe(350);
    expect(analyzed.akgDaily.energiKcal).toBe(AKG_PROFILES.PORSI_KECIL.energiKcal);
    expect(AKG_PROFILES.PORSI_KECIL.energiKcal).toBe(340);
    // 350/340 ≈ 103% of one-meal MBG target
    expect(analyzed.perPorsiAkgPct.energiKcal).toBeGreaterThan(100);
  });

  it('resolves legacy AKG aliases to MBG meal profiles', () => {
    expect(resolveAkgKey('ANAK_7_9')).toBe('PORSI_KECIL');
    expect(resolveAkgKey('ANAK_SD')).toBe('PORSI_KECIL');
    expect(resolveAkgKey('DEWASA')).toBe('PORSI_BESAR');
    expect(AKG_PROFILES[resolveAkgKey('ANAK_7_9')].energiKcal).toBe(340);
  });

  it('scales recipe nutrition by qtyKecil (pctKecil) vs qtyBesar', () => {
    const qtyBesar = 10;
    const pctKecil = DEFAULT_PCT_KECIL;
    const qtyKecil = computeQtyKecil(qtyBesar, pctKecil);
    const recipe = {
      id: 'r1',
      kode: 'RSP-1',
      nama: 'Nasi',
      yieldQty: 100,
      lines: [{
        productId: 'beras',
        qty: qtyBesar,
        qtyBesar,
        pctKecil,
        qtyKecil,
        productNama: 'Beras',
      }],
    };
    const productsById = new Map([['beras', {
      productId: 'beras',
      nutrition: {
        basis: 'PER_UNIT' as const,
        energiKcal: 1000,
        proteinG: 20,
        lemakG: 5,
        karbohidratG: 200,
      },
    }]]);

    const besar = analyzeRecipeNutrition({
      recipe,
      productsById,
      porsiFamily: 'BESAR',
      akgProfile: 'PORSI_BESAR',
    });
    const kecil = analyzeRecipeNutrition({
      recipe,
      productsById,
      porsiFamily: 'KECIL',
      akgProfile: 'PORSI_KECIL',
    });

    expect(besar.perPorsi.energiKcal).toBe(100); // 10×1000/100
    expect(kecil.perPorsi.energiKcal).toBeCloseTo(70, 5); // 70% of besar
    expect(kecil.perPorsi.energiKcal / besar.perPorsi.energiKcal).toBeCloseTo(pctKecil / 100, 5);
    expect(kecil.akgProfile).toBe('PORSI_KECIL');
    expect(besar.akgProfile).toBe('PORSI_BESAR');
    expect(kecil.akgDaily.energiKcal).toBe(340);
    expect(besar.akgDaily.energiKcal).toBe(762);
  });

  it('nutrition 300 GR (qtyBase 0.3) equals 0.3 KG — tidak 1000× overcount', () => {
    const productsById = new Map([['beras', {
      productId: 'beras',
      productNama: 'Beras',
      satuan: 'KG',
      nutrition: {
        basis: 'PER_100G' as const,
        gramsPerUnit: 1000,
        energiKcal: 350,
        proteinG: 7,
        lemakG: 1,
        karbohidratG: 78,
      },
    }]]);
    const viaKg = analyzeRecipeNutrition({
      recipe: {
        id: 'r1',
        kode: 'RSP-1',
        nama: 'Nasi',
        yieldQty: 100,
        lines: [{
          productId: 'beras',
          qty: 0.3,
          qtyBesar: 0.3,
          pctKecil: 70,
          qtyKecil: 0.21,
          satuan: 'KG',
          qtyBaseBesar: 0.3,
          qtyBaseKecil: 0.21,
          factorToBase: 1,
          baseSatuan: 'KG',
        }],
      },
      productsById,
      akgProfile: 'PORSI_KECIL',
    });
    const viaGr = analyzeRecipeNutrition({
      recipe: {
        id: 'r1',
        kode: 'RSP-1',
        nama: 'Nasi',
        yieldQty: 100,
        lines: [{
          productId: 'beras',
          qty: 300,
          qtyBesar: 300,
          pctKecil: 70,
          qtyKecil: 210,
          satuan: 'GR',
          qtyBaseBesar: 0.3,
          qtyBaseKecil: 0.21,
          factorToBase: 0.001,
          baseSatuan: 'KG',
        }],
      },
      productsById,
      akgProfile: 'PORSI_KECIL',
    });
    expect(viaGr.batch.energiKcal).toBe(viaKg.batch.energiKcal);
    // 0.3 KG × 1000g × 350/100 = 1050
    expect(viaGr.batch.energiKcal).toBe(1050);
    expect(viaGr.lines[0]?.satuan).toBe('GR');
    expect(viaGr.lines[0]?.qty).toBe(300);
  });

  it('blends plan line besar+kecil and suggests AKG profile', () => {
    expect(suggestAkgProfileForCategories([['PORSI_BESAR']])).toBe('PORSI_BESAR');
    expect(suggestAkgProfileForCategories([['PORSI_KECIL']])).toBe('PORSI_KECIL');
    expect(suggestAkgProfileForCategories([['PORSI_BESAR', 'PORSI_KECIL']])).toBe('MIXED');

    const qtyBesar = 10;
    const pctKecil = 70;
    const recipe = {
      id: 'r1',
      kode: 'RSP-1',
      nama: 'Nasi',
      yieldQty: 100,
      lines: [{
        productId: 'beras',
        qty: qtyBesar,
        qtyBesar,
        pctKecil,
        qtyKecil: computeQtyKecil(qtyBesar, pctKecil),
      }],
    };
    const productsById = new Map([['beras', {
      productId: 'beras',
      nutrition: {
        basis: 'PER_UNIT' as const,
        energiKcal: 1000,
        proteinG: 20,
        lemakG: 5,
        karbohidratG: 200,
      },
    }]]);

    // 50 besar + 50 kecil → perPorsi = (100×50 + 70×50) / 100 = 85
    const blended = analyzePlanLineNutrition({
      recipe,
      productsById,
      planLine: {
        targetPorsi: 100,
        kategoriPorsiList: ['PORSI_BESAR', 'PORSI_KECIL'],
      },
      acuanByKategori: { PORSI_BESAR: 50, PORSI_KECIL: 50 },
      akgProfile: 'PORSI_BESAR',
    });
    expect(blended.perPorsi.energiKcal).toBeCloseTo(85, 5);
    expect(blended.akgProfile).toBe('PORSI_BESAR'); // mixed → user profile

    const draft = analyzePlanDraftNutrition({
      lines: [{
        recipeId: 'r1',
        targetPorsi: 100,
        kategoriPorsiList: ['PORSI_KECIL'],
      }],
      menusById: new Map(),
      recipesById: new Map([['r1', recipe]]),
      productsById,
      akgProfile: 'PORSI_BESAR', // overridden by pure kecil line
    });
    expect('error' in draft).toBe(false);
    if ('error' in draft) return;
    expect(draft.akgProfile).toBe('PORSI_KECIL');
    expect(draft.perPorsi.energiKcal).toBeCloseTo(70, 5);
    expect(draft.perPorsiAkgPct.energiKcal).toBeCloseTo((70 / 340) * 100, 0);
    expect(AKG_COMPLIANCE_MIN_PCT).toBe(90);
  });

  it('analyzes HSL result nutrition from actualPorsi', () => {
    const productsById = new Map([['beras', {
      productId: 'beras',
      nutrition: {
        basis: 'PER_UNIT' as const,
        energiKcal: 3500,
        proteinG: 70,
        lemakG: 10,
        karbohidratG: 750,
      },
    }]]);
    const recipe = {
      id: 'r1',
      kode: 'RSP-1',
      nama: 'Nasi',
      yieldQty: 100,
      lines: [{ productId: 'beras', qty: 10, productNama: 'Beras' }],
    };
    const analyzed = analyzeResultNutrition({
      resultId: 'hsl1',
      resultNo: 'HSL-1',
      resultLines: [{
        recipeId: 'r1',
        targetPorsi: 100,
        actualPorsi: 80,
      }],
      recipesById: new Map([['r1', recipe]]),
      productsById,
      akgProfile: 'ANAK_7_9',
    });
    expect('error' in analyzed).toBe(false);
    if ('error' in analyzed) return;
    // per porsi tetap dari resep (350); batch = 350×80
    expect(analyzed.scope).toBe('result');
    expect(analyzed.perPorsi.energiKcal).toBe(350);
    expect(analyzed.yieldPorsi).toBe(80);
    expect(analyzed.akgProfile).toBe('PORSI_KECIL');
    expect(analyzed.batch.energiKcal).toBe(28000);
  });

  it('computes standard vs actual cost variance', () => {
    const products = new Map([['beras', { productId: 'beras', hargaBeli: 12000, productNama: 'Beras' }]]);
    const standard = analyzeRecipeStandardCost({
      recipe: {
        id: 'r1',
        kode: 'R',
        nama: 'Nasi',
        yieldQty: 100,
        lines: [{ productId: 'beras', qty: 10 }],
      },
      productsById: products,
    });
    expect(standard.standard.totalCost).toBe(120000);
    expect(standard.standard.perPorsi).toBe(1200);

    const actual = analyzeActualCost({
      planId: 'p1',
      issueLines: [{ productId: 'beras', qtyPlanned: 10, qtyIssued: 11 }],
      resultLines: [{
        menuId: 'm',
        recipeId: 'r',
        finishedGoodProductId: 'fg',
        targetPorsi: 100,
        actualPorsi: 100,
      }],
      productsById: products,
      standard: standard.standard,
    });
    expect(actual.actual?.totalCost).toBe(132000);
    expect(actual.variance?.amount).toBe(12000);
  });

  it('QC findings save allows FAIL (no PASS-all gate)', () => {
    const items = normalizeQcTemplateItems([
      { key: 'a', label: 'Suhu', required: true },
      { key: 'b', label: 'Opsional', required: false },
    ]);
    expect(Array.isArray(items)).toBe(true);
    if (!Array.isArray(items)) return;
    expect(assertQcCanComplete(
      [{ key: 'a', label: 'Suhu', result: 'FAIL', note: 'suhu rendah' }, { key: 'b', label: 'Opsional', result: 'NA' }],
      items,
    )).toBeNull();
    expect(assertQcCanComplete(
      [{ key: 'a', label: 'Suhu', result: 'NA' }, { key: 'b', label: 'Opsional', result: 'NA' }],
      items,
    )).toMatch(/minimal satu/i);
    expect(summarizeQcItems([
      { key: 'a', label: 'Suhu', result: 'PASS' },
      { key: 'b', label: 'Opsional', result: 'FAIL' },
    ], items).failCount).toBe(1);
  });

  it('builds 7/14/30 material forecast with shortage risk', () => {
    expect(parseHorizon('30')).toBe(30);
    const f = buildMaterialForecast({
      horizon: 7,
      points: [
        { tanggal: '2026-07-01', productId: 'beras', qty: 10 },
        { tanggal: '2026-07-02', productId: 'beras', qty: 10 },
      ],
      onHandByProduct: new Map([['beras', 5]]),
      productMeta: new Map([['beras', { productNama: 'Beras', satuan: 'KG' }]]),
      historyDays: 2,
    });
    expect(f.lines[0].risk).toBe('SHORT');
    expect(f.summary.shortCount).toBe(1);
  });

  it('ranks dashboard tips by severity', () => {
    const tips = buildFoodDashboardTips({
      openPlans: 0,
      processingPlans: 0,
      openIssues: 0,
      openResults: 0,
      openQc: 0,
      productsMissingNutrition: 3,
      recipesCoveredNutritionPct: 40,
      forecastShortCount: 2,
      costVarianceAlerts: 0,
    });
    expect(tips[0].severity).toBe('critical');
  });

  it('builds AI recommendations from ERP rules (not chat)', () => {
    const shortLine: ForecastLine = {
      productId: 'beras',
      productNama: 'Beras',
      avgDailyQty: 10,
      forecastQty: 70,
      onHandQty: 5,
      projectedShortage: 65,
      risk: 'SHORT',
    };
    const overstock: ForecastLine = {
      productId: 'minyak',
      productNama: 'Minyak',
      avgDailyQty: 1,
      forecastQty: 7,
      onHandQty: 40,
      projectedShortage: 0,
      risk: 'OK',
    };

    expect(recommendShortages([shortLine])[0].type).toBe('SHORTAGE');
    expect(recommendStockOpt([overstock])[0].type).toBe('STOCK_OPT');

    const waste = recommendWaste({
      issueLines: [{
        issueNo: 'PBL-1',
        productId: 'beras',
        productNama: 'Beras',
        qtyPlanned: 10,
        qtyIssued: 10 * (1 + WASTE_ISSUE_OVERAGE_PCT / 100) + 1,
      }],
      resultLines: [{
        resultNo: 'HSL-1',
        finishedGoodNama: 'Nasi',
        targetPorsi: 100,
        wastePorsi: 15,
      }],
    });
    expect(waste.some((w) => w.type === 'WASTE')).toBe(true);

    const subs = recommendSubstitutes({
      shortageProductIds: ['beras'],
      products: new Map([
        ['beras', { productId: 'beras', productNama: 'Beras', grup: 'Biji', hargaBeli: 12000, onHandQty: 0 }],
        ['beras2', { productId: 'beras2', productNama: 'Beras Medium', grup: 'Biji', hargaBeli: 10000, onHandQty: 20 }],
      ]),
    });
    expect(subs[0]?.evidence?.altProductId).toBe('beras2');

    const menus = recommendMenuAlt({
      plannedMenus: [{ menuId: 'm1', menuNama: 'Mahal', estimatedCostPerPorsi: 10000 }],
      activeMenus: [
        { menuId: 'm1', menuNama: 'Mahal', targetCostPerPorsi: 10000, aktif: true },
        { menuId: 'm2', menuNama: 'Hemat', targetCostPerPorsi: 7000, aktif: true },
      ],
    });
    expect(menus[0]?.type).toBe('MENU_ALT');

    const cheap = recommendCheaperSupply({
      products: [{
        productId: 'beras',
        productNama: 'Beras',
        hargaBeli: 13000,
        lastReceiptUnitPrice: 10000,
      }],
    });
    expect(cheap[0]?.type).toBe('CHEAPER_SUPPLY');

    const snap = buildRecommendations({
      horizon: 7,
      forecastLines: [shortLine, overstock],
      issueWasteLines: [],
      resultWasteLines: [],
      products: new Map([['beras', { productId: 'beras', grup: 'Biji', onHandQty: 0 }]]),
      plannedMenus: [],
      activeMenus: [],
      cheaperSupply: [],
      audience: 'kitchen',
    });
    expect(snap.items.some((i) => i.type === 'SHORTAGE')).toBe(true);
    expect(snap.summary.critical).toBeGreaterThan(0);
  });
});
