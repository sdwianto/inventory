/**
 * Satuan POTONG per baris resep (tempe/tahu dibeli per ALIR/BAK) dan pembulatan pengadaan
 * bahan volume ke kelipatan kemasan beli (mis. kecap sachet 700 ml).
 */
import { describe, expect, it } from 'vitest';
import {
  convertRecipeLineQtys,
  factorKitchenToBase,
  kitchenSatuanOptionsForBase,
  isCutProductName,
  recipeCutAllowedForBase,
  recipeCutEnabledOf,
  recipeKitchenSatuanLabel,
  validateProcurementPack,
  RECIPE_CUT_SATUAN,
} from '@/lib/food-production/recipe-uom';
import { normalizeRecipeLines, type MenuDoc, type RecipeDoc, type RecipeLine } from '@/lib/food-production/recipe';
import { analyzeRecipeNutrition } from '@/lib/food-production/nutrition';
import { recipeIngredientNeeds } from '@/lib/food-production/rencana-kebutuhan';
import {
  ceilToProcurementPack,
  explodeMaterialRequirements,
  procurementPackOf,
} from '@/lib/food-production/material-requirement';
import {
  buildPurchaseLinesFromMrp,
  mergePurchaseLinesByKode,
  procurementPackNotes,
} from '@/lib/food-production/purchase-requirement';
import { resolveRecipeBridgeInput } from '@/lib/api/product-recipe-bridge';

const tempe = { satuan: 'ALIR', recipeCutEnabled: true };
const tahu = { satuan: 'BAK', recipeCutEnabled: true };

function cutLine(
  productId: string,
  product: { satuan: string; recipeCutEnabled?: boolean },
  qtyBesar: number,
  potongPerBase: number,
): RecipeLine {
  const conv = convertRecipeLineQtys({
    qtyBesar,
    qtyKecil: qtyBesar,
    kitchenSatuan: RECIPE_CUT_SATUAN,
    product,
    strict: true,
    potongPerBase,
  });
  if ('error' in conv) throw new Error(conv.error);
  return {
    productId,
    productKode: productId.toUpperCase(),
    productNama: productId,
    qty: qtyBesar,
    qtyBesar,
    pctKecil: 100,
    qtyKecil: qtyBesar,
    satuan: conv.satuan,
    potongPerBase,
    qtyBaseBesar: conv.qtyBaseBesar,
    qtyBaseKecil: conv.qtyBaseKecil,
    factorToBase: conv.factorToBase,
    baseSatuan: conv.baseSatuan,
    factorSource: conv.factorSource,
  };
}

describe('POTONG per baris resep', () => {
  it('tempe: 1 ALIR = 20 atau 30 potong tergantung resep', () => {
    const a = convertRecipeLineQtys({
      qtyBesar: 500, qtyKecil: 500, kitchenSatuan: 'POTONG', product: tempe, strict: true, potongPerBase: 20,
    });
    const b = convertRecipeLineQtys({
      qtyBesar: 500, qtyKecil: 500, kitchenSatuan: 'POTONG', product: tempe, strict: true, potongPerBase: 30,
    });
    if ('error' in a || 'error' in b) throw new Error('konversi gagal');
    expect(a.qtyBaseBesar).toBe(25);
    expect(a.baseSatuan).toBe('ALIR');
    expect(a.factorSource).toBe('CUT');
    expect(b.qtyBaseBesar).toBeCloseTo(16.6667, 3);
  });

  it('tahu: 1 BAK = 32 atau 62 potong', () => {
    const a = factorKitchenToBase('POTONG', tahu, { potongPerBase: 32 });
    const b = factorKitchenToBase('POTONG', tahu, { potongPerBase: 62 });
    if ('error' in a || 'error' in b) throw new Error('faktor gagal');
    expect(a.factorToBase).toBeCloseTo(1 / 32, 9);
    expect(b.factorToBase).toBeCloseTo(1 / 62, 9);
    expect(a.baseSatuan).toBe('BAK');
  });

  it('menolak POTONG tanpa jumlah potong per basis', () => {
    const r = factorKitchenToBase('POTONG', tahu, {});
    expect('error' in r && r.error).toMatch(/potong per BAK/);
  });

  it('menolak POTONG untuk produk tanpa flag recipeCutEnabled', () => {
    const r = factorKitchenToBase('POTONG', { satuan: 'BAK' }, { potongPerBase: 32, strict: true });
    expect('error' in r).toBe(true);
  });

  it('opsi POTONG hanya muncul untuk basis hitung/kemasan yang diaktifkan', () => {
    expect(kitchenSatuanOptionsForBase('ALIR', { recipeCutEnabled: true })).toContain('POTONG');
    expect(kitchenSatuanOptionsForBase('ALIR', {})).not.toContain('POTONG');
    expect(kitchenSatuanOptionsForBase('KG', { recipeCutEnabled: true })).not.toContain('POTONG');
    expect(recipeCutAllowedForBase('BAK')).toBe(true);
    expect(recipeCutAllowedForBase('LTR')).toBe(false);
  });

  it('normalizeRecipeLines mewajibkan potongPerBase > 0 untuk POTONG', () => {
    const bad = normalizeRecipeLines([{ productId: 'tahu', qtyBesar: 500, satuan: 'POTONG' }]);
    expect('error' in bad && bad.error).toMatch(/potong per satuan basis/);
    const ok = normalizeRecipeLines([{ productId: 'tahu', qtyBesar: 500, satuan: 'POTONG', potongPerBase: 62 }]);
    if ('error' in ok) throw new Error(ok.error);
    expect(ok[0].potongPerBase).toBe(62);
  });

  it('normalizeRecipeLines menolak produk sama dengan ukuran potong berbeda di satu resep', () => {
    const r = normalizeRecipeLines([
      { productId: 'tahu', qtyBesar: 100, satuan: 'POTONG', potongPerBase: 32 },
      { productId: 'tahu', qtyBesar: 100, satuan: 'POTONG', potongPerBase: 62 },
    ]);
    expect('error' in r).toBe(true);
  });

  it('label dapur membawa ukuran potong supaya lembar kebutuhan tidak menggabungkan ukuran berbeda', () => {
    expect(recipeKitchenSatuanLabel(cutLine('tempe', tempe, 10, 20))).toBe('POTONG (20/ALIR)');
    expect(recipeKitchenSatuanLabel({ satuan: 'GR', baseSatuan: 'KG' })).toBe('GR');
    const needs = recipeIngredientNeeds({
      recipe: { yieldQty: 100, wastePct: 0, lines: [cutLine('tempe', tempe, 100, 30)] },
      menuTargetPorsi: 200,
      recipePerMenuPorsi: 1,
      kategoriPorsiList: ['PORSI_BESAR'],
    });
    expect(needs[0].qty).toBe(200);
    expect(needs[0].satuan).toBe('POTONG (30/ALIR)');
  });

  it('gizi POTONG = berat rata-rata per ALIR / jumlah potong', () => {
    const nutrition = { basis: 'PER_100G' as const, energiKcal: 200, proteinG: 20, lemakG: 10, karbohidratG: 10 };
    const nut = analyzeRecipeNutrition({
      recipe: { id: 'r', kode: 'R', nama: 'Tempe Goreng', yieldQty: 100, lines: [cutLine('tempe', tempe, 100, 20)] },
      productsById: new Map([['tempe', { productId: 'tempe', satuan: 'ALIR', recipeBaseGrams: 1000, nutrition }]]),
    });
    // 100 potong / 20 = 5 ALIR × 1000 g = 5000 g × 200/100 = 10000 kcal per batch
    expect(nut.batch.energiKcal).toBe(10000);
  });

  it('gizi POTONG tanpa berat per ALIR memberi peringatan, bukan angka salah', () => {
    const nut = analyzeRecipeNutrition({
      recipe: { id: 'r', kode: 'R', nama: 'Tempe Goreng', yieldQty: 100, lines: [cutLine('tempe', tempe, 100, 20)] },
      productsById: new Map([['tempe', {
        productId: 'tempe', satuan: 'ALIR',
        nutrition: { basis: 'PER_100G' as const, energiKcal: 200, proteinG: 20, lemakG: 10, karbohidratG: 10 },
      }]]),
    });
    expect(nut.batch.energiKcal).toBe(0);
    expect(nut.warnings.join(' ')).toMatch(/POTONG/);
  });
});

describe('Pembulatan kemasan beli bahan volume', () => {
  const sachet = { packMl: 700, label: 'SACHET' };

  it('1500 ml dengan kemasan 700 ml → 3 sachet (basis LTR dan ML)', () => {
    expect(ceilToProcurementPack(1.5, 'LTR', sachet)).toMatchObject({ qty: 2.1, packCount: 3 });
    expect(ceilToProcurementPack(1500, 'ML', sachet)).toMatchObject({ qty: 2100, packCount: 3 });
  });

  it('kelipatan pas tidak dinaikkan', () => {
    expect(ceilToProcurementPack(1.4, 'LTR', sachet)).toMatchObject({ qty: 1.4, packCount: 2 });
  });

  it('tanpa kemasan / bukan volume → pembulatan biasa', () => {
    expect(ceilToProcurementPack(1.5, 'LTR', null).packCount).toBeUndefined();
    expect(ceilToProcurementPack(2.3, 'PCS', sachet)).toEqual({ qty: 3 });
  });

  it('procurementPackOf hanya membaca pasangan ml + label yang valid', () => {
    expect(procurementPackOf({ procurementPackMl: 700, procurementPackLabel: 'SACHET' })).toEqual(sachet);
    expect(procurementPackOf({ procurementPackMl: 700 })).toBeNull();
    expect(procurementPackOf({ procurementPackMl: 0, procurementPackLabel: 'SACHET' })).toBeNull();
  });

  it('validateProcurementPack', () => {
    expect(validateProcurementPack('LTR', 700, 'SACHET')).toBeNull();
    expect(validateProcurementPack('LTR', 700, null)).not.toBeNull();
    expect(validateProcurementPack('KG', 700, 'SACHET')).not.toBeNull();
    expect(validateProcurementPack('LTR', 700, 'ML')).not.toBeNull();
  });
});

describe('MRP: POTONG dua ukuran + kemasan volume', () => {
  const now = new Date();
  const recipe = (id: string, lines: RecipeLine[], yieldQty = 100): RecipeDoc => ({
    id, tenantId: 't1', kode: id.toUpperCase(), nama: id, finishedGoodProductId: `fg-${id}`,
    version: 1, effectiveDate: '2026-10-01', yieldQty, wastePct: 0, lines,
    aktif: true, createdAt: now, updatedAt: now,
  });
  const kecapConv = convertRecipeLineQtys({
    qtyBesar: 1500, qtyKecil: 1500, kitchenSatuan: 'ML', product: { satuan: 'LTR' }, strict: true,
  });
  if ('error' in kecapConv) throw new Error(kecapConv.error);
  const kecapLine: RecipeLine = {
    productId: 'kecap', productKode: 'KCP', productNama: 'Kecap Manis',
    qty: 1500, qtyBesar: 1500, pctKecil: 100, qtyKecil: 1500, satuan: 'ML',
    qtyBaseBesar: kecapConv.qtyBaseBesar, qtyBaseKecil: kecapConv.qtyBaseKecil,
    factorToBase: kecapConv.factorToBase, baseSatuan: kecapConv.baseSatuan, factorSource: kecapConv.factorSource,
  };
  const rA = recipe('tempe-a', [cutLine('tempe', tempe, 100, 20)]);
  const rB = recipe('tempe-b', [cutLine('tempe', tempe, 100, 30), kecapLine], 500);

  const result = explodeMaterialRequirements({
    plan: {
      id: 'p1', noDokumen: 'RPN1', tanggal: '2026-10-07', kitchenId: 'k1', kitchenWarehouseKode: 'GKERING',
      status: 'APPROVED', kategoriPorsiList: ['PORSI_BESAR'],
      lines: [
        { recipeId: 'tempe-a', targetPorsi: 500, kategoriPorsiList: ['PORSI_BESAR'] },
        { recipeId: 'tempe-b', targetPorsi: 500, kategoriPorsiList: ['PORSI_BESAR'] },
      ],
    },
    menusById: new Map<string, MenuDoc>(),
    recipesById: new Map([[rA.id, rA], [rB.id, rB]]),
    onHandByProduct: new Map([['tempe', 0], ['kecap', 0]]),
    warehouseKode: 'GKERING',
    procurementPackByProduct: new Map([['kecap', { packMl: 700, label: 'SACHET' }]]),
  });

  it('total tempe dari dua ukuran potong dijumlahkan di ALIR lalu dibulatkan ke atas', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = result.lines.find((l) => l.productId === 'tempe');
    // 500 potong / 20 = 25 ALIR + 100 potong / 30 = 3,33 ALIR → 28,33 → beli 29 ALIR
    expect(t?.satuan).toBe('ALIR');
    expect(t?.qtyGross).toBe(29);
    expect(t?.qtyNet).toBe(29);
    const bySource = new Map(t?.sources.map((s) => [s.recipeId, s.qty]));
    expect(bySource.get('tempe-a')).toBe(25);
    expect(bySource.get('tempe-b')).toBeCloseTo(3.3333, 3);
  });

  it('kecap 1500 ml dengan sachet 700 ml → 3 sachet di MRP dan Kebutuhan Beli', () => {
    if (!result.ok) throw new Error('mrp gagal');
    const k = result.lines.find((l) => l.productId === 'kecap');
    expect(k?.qtyGross).toBe(1.5);
    expect(k?.qtyNet).toBe(2.1);
    expect(k?.packCount).toBe(3);
    expect(k?.procurementPackLabel).toBe('SACHET');
    const pr = mergePurchaseLinesByKode(buildPurchaseLinesFromMrp(result.lines));
    const prKecap = pr.find((l) => l.productId === 'kecap');
    expect(prKecap?.qtyNet).toBe(2.1);
    expect(prKecap?.packCount).toBe(3);
    expect(procurementPackNotes(pr)).toEqual(['Kecap Manis: 3 SACHET @700 ml']);
  });
});

describe('resolveRecipeBridgeInput: flag potong + kemasan beli', () => {
  it('menyimpan kemasan untuk basis volume', () => {
    const r = resolveRecipeBridgeInput({ procurementPackMl: '700', procurementPackLabel: 'sachet' }, 'LTR', {});
    if ('error' in r) throw new Error(r.error);
    expect(r.values.procurementPackMl).toBe(700);
    expect(r.values.procurementPackLabel).toBe('SACHET');
  });

  it('menolak kemasan untuk basis non-volume dan pasangan tidak lengkap', () => {
    expect('error' in resolveRecipeBridgeInput({ procurementPackMl: 700, procurementPackLabel: 'SACHET' }, 'KG', {})).toBe(true);
    expect('error' in resolveRecipeBridgeInput({ procurementPackMl: 700 }, 'LTR', {})).toBe(true);
  });

  it('flag potong hanya untuk basis hitung/kemasan', () => {
    const ok = resolveRecipeBridgeInput({ recipeCutEnabled: true }, 'ALIR', {});
    if ('error' in ok) throw new Error(ok.error);
    expect(ok.values.recipeCutEnabled).toBe(true);
    expect('error' in resolveRecipeBridgeInput({ recipeCutEnabled: true }, 'KG', {})).toBe(true);
  });
});

describe('POTONG otomatis untuk tahu/tempe', () => {
  it('nama tahu/tempe dikenali, kembang tahu tidak', () => {
    expect(isCutProductName('Tempe Seno')).toBe(true);
    expect(isCutProductName('TAHU GEMBOS')).toBe(true);
    expect(isCutProductName('Kembang Tahu Premiun 62cm')).toBe(false);
    expect(isCutProductName('Tahunan Beras')).toBe(false);
    expect(isCutProductName('Bakso Sapi')).toBe(false);
  });

  it('aktif tanpa centang untuk basis hitung; false eksplisit mematikan; basis massa ditolak', () => {
    expect(recipeCutEnabledOf({ nama: 'Tempe Seno', satuan: 'ALIR' })).toBe(true);
    expect(recipeCutEnabledOf({ nama: 'Tahu Gembos', satuan: 'PCS', recipeCutEnabled: null })).toBe(true);
    expect(recipeCutEnabledOf({ nama: 'Tahu Putih', satuan: 'BAK', recipeCutEnabled: false })).toBe(false);
    expect(recipeCutEnabledOf({ nama: 'Tahu Kering', satuan: 'KG' })).toBe(false);
    expect(recipeCutEnabledOf({ nama: 'Kol', satuan: 'PCS', recipeCutEnabled: true })).toBe(true);
    expect(recipeCutEnabledOf({ nama: 'Kol', satuan: 'PCS' })).toBe(false);
  });

  it('opsi dan faktor POTONG mengikuti deteksi nama', () => {
    expect(kitchenSatuanOptionsForBase('ALIR', { nama: 'Tempe Seno' })).toContain(RECIPE_CUT_SATUAN);
    expect(kitchenSatuanOptionsForBase('ALIR', { nama: 'Tempe Seno', recipeCutEnabled: false })).not.toContain(RECIPE_CUT_SATUAN);
    const f = factorKitchenToBase('POTONG', { satuan: 'ALIR', nama: 'Tempe Seno' }, { potongPerBase: 8, strict: true });
    if ('error' in f) throw new Error(f.error);
    expect(f.factorToBase).toBeCloseTo(1 / 8, 9);
    expect(f.factorSource).toBe('CUT');
  });

  it('simpan field jembatan lain tidak mengubah flag kosong jadi false', () => {
    const untouched = resolveRecipeBridgeInput({ recipeBaseGrams: 250 }, 'ALIR', { nama: 'Tempe Seno' });
    if ('error' in untouched) throw new Error(untouched.error);
    expect(untouched.values.recipeCutEnabled).toBeNull();
    const keptFalse = resolveRecipeBridgeInput({ recipeBaseGrams: 250 }, 'ALIR', { recipeCutEnabled: false });
    if ('error' in keptFalse) throw new Error(keptFalse.error);
    expect(keptFalse.values.recipeCutEnabled).toBe(false);
    const off = resolveRecipeBridgeInput({ recipeCutEnabled: false }, 'ALIR', { nama: 'Tempe Seno' });
    if ('error' in off) throw new Error(off.error);
    expect(off.values.recipeCutEnabled).toBe(false);
    expect(off.changed).toBe(true);
  });

  it('MRP: tempe tanpa centang, 500 potong (8/ALIR) untuk 640 porsi → 80 ALIR', () => {
    const now = new Date();
    const seno = { satuan: 'ALIR', nama: 'Tempe Seno' };
    const r: RecipeDoc = {
      id: 'seno', tenantId: 't1', kode: 'SENO', nama: 'Tempe Goreng', finishedGoodProductId: 'fg-seno',
      version: 1, effectiveDate: '2026-10-01', yieldQty: 500, wastePct: 0,
      lines: [cutLine('seno', seno, 500, 8)], aktif: true, createdAt: now, updatedAt: now,
    };
    const res = explodeMaterialRequirements({
      plan: {
        id: 'p2', noDokumen: 'RPN2', tanggal: '2026-10-07', kitchenId: 'k1', kitchenWarehouseKode: 'GKERING',
        status: 'APPROVED', kategoriPorsiList: ['PORSI_BESAR'],
        lines: [{ recipeId: 'seno', targetPorsi: 640, kategoriPorsiList: ['PORSI_BESAR'] }],
      },
      menusById: new Map<string, MenuDoc>(),
      recipesById: new Map([[r.id, r]]),
      onHandByProduct: new Map([['seno', 0]]),
      warehouseKode: 'GKERING',
    });
    if (!res.ok) throw new Error('mrp gagal');
    const t = res.lines.find((l) => l.productId === 'seno');
    // 640 porsi × (500 potong / 500 porsi) = 640 potong / 8 = 80 ALIR
    expect(t?.satuan).toBe('ALIR');
    expect(t?.qtyNet).toBe(80);
  });
});
