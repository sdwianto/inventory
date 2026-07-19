import { describe, expect, it } from 'vitest';
import { FP_DOC_PREFIX, FP_DOC_TYPES } from '@/lib/food-production/document';
import {
  normalizeNutritionFacts,
  contributionFromProduct,
  analyzeRecipeNutrition,
  AKG_PROFILES,
} from '@/lib/food-production/nutrition';
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
      akgProfile: 'ANAK_SD',
    });
    // 10 unit × 3500 kkal / 100 porsi = 350 kkal per porsi
    expect(analyzed.perPorsi.energiKcal).toBe(350);
    expect(analyzed.akgDaily.energiKcal).toBe(AKG_PROFILES.ANAK_SD.energiKcal);
    expect(analyzed.perPorsiAkgPct.energiKcal).toBeGreaterThan(0);
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
