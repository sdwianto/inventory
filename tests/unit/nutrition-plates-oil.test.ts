import { describe, it, expect } from 'vitest';
import { detectCookMethod, estimateOilAbsorption } from '@/lib/food-production/oil-absorption';
import {
  analyzePlanNutrition,
  analyzeRecipeNutrition,
  analyzeResultNutrition,
  type ProductNutritionRef,
} from '@/lib/food-production/nutrition';
import { consolidateRecipeLines, normalizeRecipeLines, type RecipeDoc } from '@/lib/food-production/recipe';
import type { KategoriPorsi, ProductionPlanLine } from '@/lib/food-production/production-plan';

const per100 = (energiKcal: number, proteinG: number, lemakG: number, karbohidratG: number, extra: Record<string, unknown> = {}) => ({
  basis: 'PER_100G' as const,
  gramsPerUnit: 1000,
  bddPct: 100,
  energiKcal,
  proteinG,
  lemakG,
  karbohidratG,
  ...extra,
});

const PRODUCTS: ProductNutritionRef[] = [
  { productId: 'lele', productNama: 'Lele Fillet', satuan: 'KG', nutrition: per100(84, 14.8, 2.3, 0, { tkpiCode: 'GR050' }) },
  { productId: 'minyak', productNama: 'Minyak Goreng Refil 2L', satuan: 'PCS', nutrition: per100(884, 0, 100, 0, { tkpiCode: 'KR012' }) },
  { productId: 'wijen', productNama: 'Minyak Wijen 620 ml', satuan: 'BTL', nutrition: per100(884, 0, 100, 0) },
  { productId: 'terigu', productNama: 'Tepung Terigu 1kg', satuan: 'KG', nutrition: per100(333, 9, 1, 77, { tkpiCode: 'AP001' }) },
  { productId: 'buncis', productNama: 'Buncis', satuan: 'KG', nutrition: per100(34, 2.4, 0.3, 7.2, { tkpiCode: 'DR010' }) },
  { productId: 'beras', productNama: 'Beras', satuan: 'KG', nutrition: per100(357, 8.4, 1.7, 77.1, { tkpiCode: 'AR003' }) },
];
const productsById = new Map(PRODUCTS.map((p) => [p.productId, p]));

function recipe(id: string, nama: string, lines: Array<[string, number, string, number?]>, extra: Partial<RecipeDoc> = {}): RecipeDoc {
  return {
    id,
    tenantId: 't',
    kode: id.toUpperCase(),
    nama,
    version: 1,
    effectiveDate: '2026-10-01',
    yieldQty: 500,
    aktif: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    lines: lines.map(([productId, qty, satuan, pctKecil]) => ({
      productId,
      qty,
      qtyBesar: qty,
      pctKecil: pctKecil ?? 100,
      qtyKecil: (qty * (pctKecil ?? 100)) / 100,
      satuan,
    })),
    ...extra,
  };
}

/** RSP-0126: lele 30 kg + tepung + minyak goreng 14 L + minyak wijen 250 ml. */
const LELE = recipe('lele-krispy', 'Lele Fillet Krispy', [['lele', 30, 'KG'], ['terigu', 6, 'KG'], ['minyak', 14, 'L'], ['wijen', 250, 'ML']]);
const TUMIS = recipe('tumis-buncis', 'Tumis Buncis', [['buncis', 20, 'KG'], ['minyak', 500, 'ML']]);
const NASI = recipe('nasi', 'Nasi Putih', [['beras', 27.5, 'KG', 80]]);

describe('serapan minyak otomatis (DPM Kemenkes)', () => {
  it('goreng ikan: 20% x berat lele, dibatasi minyak resep; tepung & minyak wijen tidak ikut', () => {
    const a = analyzeRecipeNutrition({ recipe: LELE, productsById });
    // 30 kg lele × 20% = 6 kg terserap dari 14 L × 0,92 = 12,88 kg minyak
    expect(a.oilAbsorption?.basis).toContain('ikan goreng 20%');
    expect(a.oilAbsorption?.absorbedGramsPerPorsi).toBeCloseTo(12, 1);
    expect(a.oilAbsorption?.serapPct).toBeCloseTo(46.6, 1);
    const oilLine = a.lines.find((l) => l.productId === 'minyak');
    expect(oilLine?.contribution.energiKcal).toBeCloseTo(6000 * 8.84, 0);
    const wijen = a.lines.find((l) => l.productId === 'wijen');
    expect(wijen?.contribution.energiKcal).toBeCloseTo(250 * 8.84, 0);
  });

  it('tumis sayur: minyak sedikit → termakan seluruhnya (berat jenis 0,92)', () => {
    const a = analyzeRecipeNutrition({ recipe: TUMIS, productsById });
    expect(a.oilAbsorption?.serapPct).toBe(100);
    const oil = a.lines.find((l) => l.productId === 'minyak');
    expect(oil?.contribution.energiKcal).toBeCloseTo(460 * 8.84, 0);
    expect(oil?.serapPct).toBe(100);
  });

  it('deteksi cara masak dari variasi nama resep', () => {
    expect(detectCookMethod('Tahu Gorengan')).toBe('GORENG');
    expect(detectCookMethod('Ayam Digoreng Bumbu')).toBe('GORENG');
    expect(detectCookMethod('Tempe Krispi')).toBe('GORENG');
    expect(detectCookMethod('Osengan Kangkung')).toBe('TUMIS');
    expect(detectCookMethod('Cah Sawi')).toBe('TUMIS');
    expect(detectCookMethod('Sayur Asem')).toBeUndefined();
    expect(detectCookMethod('Tahu Gorengan', 'TANPA_MINYAK')).toBe('TANPA_MINYAK');
  });

  it('cara masak tak terdeteksi → cadangan 12% berat bahan', () => {
    const r = estimateOilAbsorption({
      recipeNama: 'Lele Spesial',
      items: [
        { key: 0, productNama: 'Lele', tkpiCode: 'GR050', grams: 30000, satuan: 'GR', lemakPer100: 2 },
        { key: 1, productNama: 'Minyak Goreng', grams: 14000, satuan: 'GR', lemakPer100: 100 },
      ],
    });
    expect(r.basis).toContain('cadangan 12%');
    expect(r.absorbedGrams).toBeCloseTo(3600, 0);
  });

  it('override manual per baris & TANPA_MINYAK', () => {
    const manual = analyzeRecipeNutrition({
      recipe: { ...LELE, lines: LELE.lines.map((l) => (l.productId === 'minyak' ? { ...l, serapPct: 10 } : l)) },
      productsById,
    });
    expect(manual.oilAbsorption?.manual).toBe(true);
    expect(manual.oilAbsorption?.serapPct).toBe(10);
    const none = analyzeRecipeNutrition({ recipe: { ...LELE, metodeMasak: 'TANPA_MINYAK' }, productsById });
    expect(none.lines.find((l) => l.productId === 'minyak')?.contribution.energiKcal).toBe(0);
  });

  it('serapPct divalidasi & digabung tertimbang saat bahan sama', () => {
    expect(normalizeRecipeLines([{ productId: 'minyak', qtyBesar: 1, satuan: 'L', serapPct: 150 }])).toEqual({
      error: 'Baris 1: Serap % harus 0–100',
    });
    const ok = normalizeRecipeLines([{ productId: 'minyak', qtyBesar: 1, satuan: 'L', serapPct: 20 }]);
    expect(Array.isArray(ok) && ok[0].serapPct).toBe(20);
    const merged = consolidateRecipeLines([
      { productId: 'm', qty: 1, qtyBesar: 1, pctKecil: 100, qtyKecil: 1, serapPct: 20 },
      { productId: 'm', qty: 3, qtyBesar: 3, pctKecil: 100, qtyKecil: 3 },
    ]);
    expect(merged[0].serapPct).toBe(80);
  });
});

const ALL: KategoriPorsi[] = ['PORSI_KECIL', 'PORSI_BESAR', 'POSYANDU_BALITA', 'POSYANDU_BUMIL', 'POSYANDU_BUSUI', 'ORGANOLEPTIK'];
const recipesById = new Map([LELE, TUMIS, NASI].map((r) => [r.id, r]));

describe('Est. AKG per piring keluarga porsi', () => {
  const lines: ProductionPlanLine[] = [
    { recipeId: 'nasi', targetPorsi: 1113, kategoriPorsiList: ALL },
    { recipeId: 'lele-krispy', targetPorsi: 1113, kategoriPorsiList: ALL },
    { recipeId: 'tumis-buncis', targetPorsi: 5, kategoriPorsiList: ['ORGANOLEPTIK'] },
  ];
  const analyze = (l: ProductionPlanLine[]) => {
    const r = analyzePlanNutrition({ planId: 'p', planLines: l, menusById: new Map(), recipesById, productsById, planKategoriPorsiList: ALL });
    if ('error' in r) throw new Error(r.error);
    return r;
  };

  it('Kecil pakai qtyKecil vs target Kecil, Besar pakai qtyBesar vs target Besar; organoleptik tidak ikut', () => {
    const r = analyze(lines);
    const kecil = r.plates!.find((p) => p.family === 'KECIL')!;
    const besar = r.plates!.find((p) => p.family === 'BESAR')!;
    expect(kecil.akgDaily.energiKcal).toBe(340);
    expect(besar.akgDaily.energiKcal).toBe(762);
    expect(kecil.recipes.map((x) => x.recipeId).sort()).toEqual(['lele-krispy', 'nasi']);
    const nasiKecil = kecil.recipes.find((x) => x.recipeId === 'nasi')!.energiKcal;
    const nasiBesar = besar.recipes.find((x) => x.recipeId === 'nasi')!.energiKcal;
    expect(nasiKecil).toBeCloseTo(nasiBesar * 0.8, 0);
    expect(kecil.perPorsiAkgPct.energiKcal).toBeCloseTo((kecil.perPorsi.energiKcal / 340) * 100, 0);
  });

  it('tidak bergantung jumlah porsi/buffer', () => {
    const a = analyze(lines).plates!;
    const b = analyze(lines.map((l) => ({ ...l, targetPorsi: l.targetPorsi * 1.03 }))).plates!;
    expect(b.map((p) => Math.round(p.perPorsi.energiKcal))).toEqual(a.map((p) => Math.round(p.perPorsi.energiKcal)));
  });

  it('resep pengganti alergi tidak ditambahkan ke piring reguler', () => {
    const base = analyze(lines).plates!;
    const withAlergi = analyze([
      ...lines,
      { recipeId: 'tumis-buncis', targetPorsi: 4, kategoriPorsiList: ['PORSI_BESAR'], notes: 'ALERGI: telur' },
    ]).plates!;
    expect(withAlergi.map((p) => Math.round(p.perPorsi.energiKcal))).toEqual(base.map((p) => Math.round(p.perPorsi.energiKcal)));
  });

  it('hanya keluarga yang ada di RPN', () => {
    const r = analyze([{ recipeId: 'nasi', targetPorsi: 100, kategoriPorsiList: ['PORSI_KECIL', 'POSYANDU_BALITA'] }]);
    expect(r.plates!.map((p) => p.family)).toEqual(['KECIL']);
  });

  it('hasil produksi: hanya resep yang diproduksi, kategori dari baris rencana', () => {
    const r = analyzeResultNutrition({
      resultId: 'h',
      resultLines: [
        { recipeId: 'nasi', actualPorsi: 1100 },
        { recipeId: 'lele-krispy', actualPorsi: 0 },
      ] as never,
      recipesById,
      productsById,
      planLines: lines,
      planKategoriPorsiList: ALL,
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.plates!.find((p) => p.family === 'BESAR')!.recipes.map((x) => x.recipeId)).toEqual(['nasi']);
  });
});
