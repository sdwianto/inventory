import { describe, it, expect } from 'vitest';
import { planRecipientPorsi, resultRecipientPorsi, type ProductionPlanLine } from '@/lib/food-production/production-plan';
import { resolvePlanPenerima, resolvePlanPenerimaPorsi } from '@/lib/food-production/portion-target';
import { analyzePlanNutrition, analyzeResultNutrition } from '@/lib/food-production/nutrition';
import { analyzeActualCost, analyzePlanStandardCost } from '@/lib/food-production/cost';
import { dayPenerimaPorsi, overlappingPlans } from '@/lib/food-production/plan-calendar';
import type { KategoriPorsi } from '@/lib/food-production/production-plan';

const ALL: KategoriPorsi[] = [
  'PORSI_KECIL', 'PORSI_BESAR', 'POSYANDU_BALITA', 'POSYANDU_BUMIL', 'POSYANDU_BUSUI', 'ORGANOLEPTIK',
];

/** Bentuk RPN2610000023: 7 resep untuk semua kategori + 2 resep alergi organoleptik. */
function rpnLines(): ProductionPlanLine[] {
  const main = Array.from({ length: 7 }, (_, i) => ({
    recipeId: `r${i}`,
    targetPorsi: 1222,
    kategoriPorsiList: ALL,
  }));
  return [
    ...main,
    { recipeId: 'alergi1', targetPorsi: 2, kategoriPorsiList: ['ORGANOLEPTIK'] },
    { recipeId: 'alergi2', targetPorsi: 3, kategoriPorsiList: ['ORGANOLEPTIK'] },
  ];
}

const PANEL = {
  PORSI_KECIL: 343,
  PORSI_BESAR: 413,
  POSYANDU_BALITA: 346,
  POSYANDU_BUMIL: 31,
  POSYANDU_BUSUI: 76,
  ORGANOLEPTIK: 13,
};

describe('jumlah penerima RPN', () => {
  it('baris resep beririsan: porsi terbesar, bukan jumlah semua resep (8559)', () => {
    expect(planRecipientPorsi(rpnLines(), ALL)).toBe(1222);
  });

  it('kelompok kategori terpisah (RPN gabungan) dijumlahkan', () => {
    const lines: ProductionPlanLine[] = [
      { recipeId: 'a', targetPorsi: 756, kategoriPorsiList: ['PORSI_KECIL', 'PORSI_BESAR'] },
      { recipeId: 'b', targetPorsi: 756, kategoriPorsiList: ['PORSI_KECIL', 'PORSI_BESAR'] },
      { recipeId: 'c', targetPorsi: 466, kategoriPorsiList: ['POSYANDU_BALITA', 'POSYANDU_BUMIL'] },
    ];
    expect(planRecipientPorsi(lines)).toBe(756 + 466);
  });

  it('baris tanpa kategori memakai kategori rencana', () => {
    const lines: ProductionPlanLine[] = [
      { recipeId: 'a', targetPorsi: 100 },
      { recipeId: 'b', targetPorsi: 100 },
    ];
    expect(planRecipientPorsi(lines, ['PORSI_KECIL'])).toBe(100);
    expect(planRecipientPorsi(lines)).toBe(100);
  });

  it('sumber utama = total panel Kategori Porsi (1222)', () => {
    const plan = { lines: rpnLines(), kategoriPorsiList: ALL };
    expect(resolvePlanPenerimaPorsi(plan, PANEL)).toBe(1222);
  });

  it('panel dibatasi kategori RPN', () => {
    const plan = { lines: [{ recipeId: 'a', targetPorsi: 756 }], kategoriPorsiList: ['PORSI_KECIL', 'PORSI_BESAR'] };
    expect(resolvePlanPenerimaPorsi(plan, PANEL)).toBe(343 + 413);
  });

  it('RPN parsial (ad-hoc sebagian penerima): tidak melebihi porsi yang dimasak', () => {
    const plan = { lines: [{ recipeId: 'snack', targetPorsi: 100 }], kategoriPorsiList: ['PORSI_KECIL'] };
    const r = resolvePlanPenerima(plan, PANEL);
    expect(r.penerimaPorsi).toBe(100);
    expect(r.penerimaByKategori).toEqual({ PORSI_KECIL: 100 });
    // RPN utama + ad-hoc untuk kategori sama: total harian tetap panel (343), bukan 443
    expect(dayPenerimaPorsi([
      { status: 'APPROVED', kitchenId: 'k1', ...resolvePlanPenerima({ lines: [{ recipeId: 'a', targetPorsi: 343 }], kategoriPorsiList: ['PORSI_KECIL'] }, PANEL) },
      { status: 'APPROVED', kitchenId: 'k1', ...r },
    ])).toBe(343);
  });

  it('porsi baris melebihi panel: tetap angka panel', () => {
    const plan = { lines: [{ recipeId: 'a', targetPorsi: 1300, kategoriPorsiList: ALL }], kategoriPorsiList: ALL };
    expect(resolvePlanPenerimaPorsi(plan, PANEL)).toBe(1222);
  });

  it('panel kosong / tidak ada: cadangan dari baris resep', () => {
    const plan = { lines: rpnLines(), kategoriPorsiList: ALL };
    expect(resolvePlanPenerimaPorsi(plan, null)).toBe(1222);
    expect(resolvePlanPenerimaPorsi(plan, { PORSI_KECIL: 0 })).toBe(1222);
  });
});

describe('Est. AKG / porsi RPN', () => {
  it('total gizi semua resep ÷ penerima (bukan rata-rata per resep)', () => {
    const products = new Map([['p', {
      productId: 'p',
      nutrition: { basis: 'PER_UNIT' as const, energiKcal: 100, proteinG: 1, lemakG: 0, karbohidratG: 0 },
    }]]);
    const recipe = (id: string) => ({
      id, kode: id, nama: id, yieldQty: 1,
      lines: [{ productId: 'p', qty: 1, qtyBesar: 1, pctKecil: 100, qtyKecil: 1 }],
    });
    const lines: ProductionPlanLine[] = [
      { recipeId: 'a', targetPorsi: 10, kategoriPorsiList: ['PORSI_BESAR'] },
      { recipeId: 'b', targetPorsi: 10, kategoriPorsiList: ['PORSI_BESAR'] },
      { recipeId: 'c', targetPorsi: 10, kategoriPorsiList: ['PORSI_BESAR'] },
    ];
    const a = analyzePlanNutrition({
      planId: 'p1',
      planLines: lines,
      menusById: new Map(),
      recipesById: new Map(['a', 'b', 'c'].map((id) => [id, recipe(id)])),
      productsById: products,
      akgProfile: 'PORSI_BESAR',
    });
    expect('error' in a).toBe(false);
    if ('error' in a) return;
    expect(a.yieldPorsi).toBe(10);
    expect(a.perPorsi.energiKcal).toBeCloseTo(300, 5);

    const withPanel = analyzePlanNutrition({
      planId: 'p1',
      planLines: lines,
      menusById: new Map(),
      recipesById: new Map(['a', 'b', 'c'].map((id) => [id, recipe(id)])),
      productsById: products,
      akgProfile: 'PORSI_BESAR',
      penerimaPorsi: 12,
    });
    if ('error' in withPanel) throw new Error(withPanel.error);
    expect(withPanel.yieldPorsi).toBe(12);
    expect(withPanel.perPorsi.energiKcal).toBeCloseTo(250, 5);

    const resultLines = ['a', 'b', 'c'].map((recipeId) => ({ recipeId, targetPorsi: 10, actualPorsi: 10 }));
    const actual = analyzeResultNutrition({
      resultId: 'h1',
      resultLines,
      recipesById: new Map(['a', 'b', 'c'].map((id) => [id, recipe(id)])),
      productsById: products,
      akgProfile: 'PORSI_BESAR',
      penerimaPorsi: resultRecipientPorsi(resultLines, lines),
    });
    if ('error' in actual) throw new Error(actual.error);
    expect(actual.yieldPorsi).toBe(10);
    expect(actual.perPorsi.energiKcal).toBeCloseTo(300, 5);
  });
});

describe('Food Cost per penerima', () => {
  it('penerima aktual dari Hasil Produksi dikelompokkan per kategori rencana', () => {
    const results = [
      ...Array.from({ length: 7 }, (_, i) => ({ recipeId: `r${i}`, actualPorsi: 1210 })),
      { recipeId: 'alergi1', actualPorsi: 2 },
      { recipeId: 'alergi2', actualPorsi: 3 },
    ];
    expect(resultRecipientPorsi(results, rpnLines(), ALL)).toBe(1210);
    expect(resultRecipientPorsi([], rpnLines(), ALL)).toBe(0);
  });

  it('standar dan aktual per porsi dibagi penerima; variance total tidak berubah', () => {
    const products = new Map([['p', { productId: 'p', hargaBeli: 1000 }]]);
    const recipe = (id: string) => ({ id, kode: id, nama: id, yieldQty: 1, lines: [{ productId: 'p', qty: 1, qtyBesar: 1 }] });
    const lines: ProductionPlanLine[] = ['a', 'b'].map((id) => ({ recipeId: id, targetPorsi: 100, kategoriPorsiList: ['PORSI_BESAR'] }));
    const input = {
      planId: 'p1',
      planLines: lines,
      menusById: new Map(),
      recipesById: new Map(['a', 'b'].map((id) => [id, recipe(id)])) as never,
      productsById: products,
    };
    const lama = analyzePlanStandardCost(input);
    const baru = analyzePlanStandardCost({ ...input, penerimaPorsi: 100 });
    if ('error' in lama || 'error' in baru) throw new Error('analisis gagal');
    expect(baru.standard.totalCost).toBe(lama.standard.totalCost);
    expect(lama.standard.perPorsi).toBe(lama.standard.totalCost / 200);
    expect(baru.standard.perPorsi).toBe(baru.standard.totalCost / 100);

    const actual = analyzeActualCost({
      planId: 'p1',
      issueLines: [{ productId: 'p', qtyIssued: 220 }] as never,
      resultLines: [{ recipeId: 'a', actualPorsi: 98 }, { recipeId: 'b', actualPorsi: 98 }] as never,
      productsById: products,
      standard: baru.standard,
      penerimaPorsi: 98,
    });
    expect(actual.actual?.yieldPorsi).toBe(98);
    expect(actual.actual?.perPorsi).toBeCloseTo(220_000 / 98, 2);
    expect(actual.variance?.amount).toBe(220_000 - baru.standard.totalCost);
  });
});

describe('total penerima harian', () => {
  const kecil = { PORSI_KECIL: 343 };
  it('RPN dengan kategori sama di dapur & tanggal sama dihitung sekali', () => {
    expect(dayPenerimaPorsi([
      { status: 'APPROVED', kitchenId: 'k1', penerimaPorsi: 343, penerimaByKategori: kecil },
      { status: 'DRAFT', kitchenId: 'k1', penerimaPorsi: 756, penerimaByKategori: { ...kecil, PORSI_BESAR: 413 } },
    ])).toBe(756);
  });

  it('dapur berbeda dijumlah; batal diabaikan; tanpa panel dijumlah apa adanya', () => {
    expect(dayPenerimaPorsi([
      { status: 'APPROVED', kitchenId: 'k1', penerimaPorsi: 343, penerimaByKategori: kecil },
      { status: 'APPROVED', kitchenId: 'k2', penerimaPorsi: 343, penerimaByKategori: kecil },
      { status: 'CANCELLED', kitchenId: 'k1', penerimaPorsi: 999, penerimaByKategori: { PORSI_BESAR: 999 } },
      { status: 'DRAFT', kitchenId: 'k1', penerimaPorsi: 50 },
    ])).toBe(343 + 343 + 50);
  });

  it('peringatan RPN tumpang tindih hanya untuk dapur, tanggal, dan kategori yang beririsan', () => {
    const base = { id: 'a', noDokumen: 'A', status: 'DRAFT', kitchenId: 'k1', tanggal: '2026-10-07', kategoriPorsiList: ['PORSI_KECIL'] };
    const others = [
      base,
      { ...base, id: 'b', kategoriPorsiList: ['PORSI_KECIL', 'PORSI_BESAR'] },
      { ...base, id: 'c', kategoriPorsiList: ['PORSI_BESAR'] },
      { ...base, id: 'd', kitchenId: 'k2' },
      { ...base, id: 'e', tanggal: '2026-10-08' },
      { ...base, id: 'f', status: 'CANCELLED' },
    ];
    expect(overlappingPlans(base, others).map((o) => o.id)).toEqual(['b']);
  });
});
