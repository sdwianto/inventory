import { describe, expect, it } from 'vitest';
import { RECIPE_NEED_BUFFER_PCT } from '@/lib/food-production/production-plan';
import { emptyPortionTargets } from '@/lib/food-production/portion-target';
import {
  acuanKerjaDraftWatermark,
  acuanKerjaFileName,
  buildKebutuhanBahanFromWeeklyDay,
  buildKebutuhanBahanHarian,
  formulaQtyWithBuffer,
  hidanganInputFromPlanLines,
  type KebutuhanRecipeRef,
} from '@/lib/food-production/kebutuhan-bahan-harian';

const TANGGAL = '2026-09-22';

function recipeNasi(): KebutuhanRecipeRef {
  return {
    id: 'nasi',
    kode: 'NASI',
    nama: 'Nasi kunyit',
    aktif: true,
    kategoriMenu: 'KARBOHIDRAT',
    yieldQty: 500,
    wastePct: 0,
    lines: [{
      productId: 'beras',
      productKode: 'BRS',
      productNama: 'Beras',
      qty: 500,
      qtyBesar: 500,
      pctKecil: 70,
      qtyKecil: 350,
      satuan: 'GR',
    }],
  };
}

function recipesMap(...rows: KebutuhanRecipeRef[]) {
  return new Map(rows.map((r) => [r.id, r]));
}

describe('kebutuhan bahan harian — rumus Excel lembar 2', () => {
  it('500 g × 2634/500 × 1,03 ≈ 2,72 kg (2713 g) — semua PORSI_BESAR', () => {
    expect(RECIPE_NEED_BUFFER_PCT).toBe(3);
    const exact = formulaQtyWithBuffer({
      qtyResep: 500,
      porsi: 2634,
      yieldQty: 500,
      bufferPct: 3,
    });
    expect(exact).toBeCloseTo(2713.02, 2);
    expect(exact / 1000).toBeCloseTo(2.713, 2);

    const porsiByKategori = {
      ...emptyPortionTargets(),
      PORSI_BESAR: 2634,
    };

    const built = buildKebutuhanBahanFromWeeklyDay({
      porsiByKategori,
      slots: { KARBOHIDRAT: ['nasi'] },
      alergi: [],
    }, recipesMap(recipeNasi()));

    expect(built.errors).toEqual([]);
    expect(built.hidangan).toHaveLength(1);
    expect(built.hidangan[0].targetPorsi).toBe(2634);
    expect(built.hidangan[0].slot).toBe('KARBOHIDRAT');
    expect(built.hidangan[0].yieldQty).toBe(500);
    expect(built.rekap).toHaveLength(1);
    expect(built.rekap[0].productNama).toBe('Beras');
    expect(built.rekap[0].satuan).toBe('GR');
    expect(built.rekap[0].qtyExact).toBeCloseTo(2713.02, 1);
    expect(built.rekap[0].qtyExact / 1000).toBeCloseTo(2.713, 2);
    expect(built.rekap[0].qty).toBe(2714);
    expect(built.hidangan[0].lines[0].qtyBesarPart).toBeCloseTo(2713.02, 1);
    expect(built.hidangan[0].lines[0].qtyKecilPart).toBe(0);
    expect(built.acuanResep).toHaveLength(1);
    expect(built.acuanResep[0].porsiAcuan).toBe(500);
    expect(built.acuanResep[0].yieldQty).toBe(500);
    expect(built.acuanResep[0].lines[0].qtyBesar).toBe(500);
    expect(built.acuanResep[0].lines[0].qtyKecil).toBe(350);
  });

  it('campuran 6-key kecil/besar tidak memakai rumus all-besar 2,72 kg', () => {
    const built = buildKebutuhanBahanFromWeeklyDay({
      porsiByKategori: {
        ...emptyPortionTargets(),
        PORSI_BESAR: 1000,
        PORSI_KECIL: 1634,
      },
      slots: { KARBOHIDRAT: ['nasi'] },
      alergi: [],
    }, recipesMap(recipeNasi()));

    expect(built.hidangan[0].targetPorsi).toBe(2634);
    const line = built.hidangan[0].lines[0];
    expect(line.qtyBesarPart).toBeCloseTo(1030, 2);
    expect(line.qtyKecilPart).toBeCloseTo(1178.114, 2);
    expect(built.rekap[0].qtyExact).toBeCloseTo(2208.114, 2);
    expect(built.rekap[0].qtyExact).not.toBeCloseTo(2713.02, 0);
    expect(built.rekap[0].qty).toBe(2209);
  });

  it('alergi adds extra SKU qty and does not reduce slot PM', () => {
    const tahu: KebutuhanRecipeRef = {
      id: 'tahu',
      kode: 'TAHU',
      nama: 'Tahu kukus',
      aktif: true,
      kategoriMenu: 'LAUK_NABATI',
      yieldQty: 1,
      wastePct: 0,
      lines: [{
        productId: 'tahu-p',
        productKode: 'THU',
        productNama: 'Tahu',
        qty: 80,
        qtyBesar: 80,
        pctKecil: 70,
        qtyKecil: 56,
        satuan: 'GR',
      }],
    };
    const built = buildKebutuhanBahanFromWeeklyDay({
      porsiByKategori: { ...emptyPortionTargets(), PORSI_BESAR: 10, ORGANOLEPTIK: 2 },
      slots: { KARBOHIDRAT: ['nasi'] },
      alergi: [{ recipeId: 'tahu', porsi: 4, catatan: 'kacang' }],
    }, recipesMap(recipeNasi(), tahu));

    expect(built.hidangan[0].targetPorsi).toBe(12);
    expect(built.hidangan[1].isAlergi).toBe(true);
    expect(built.hidangan[1].slot).toBe('ALERGI');
    expect(built.hidangan[1].targetPorsi).toBe(4);
    expect(built.rekap.some((r) => r.productId === 'beras')).toBe(true);
    expect(built.rekap.some((r) => r.productId === 'tahu-p')).toBe(true);
  });

  it('hidanganInputFromPlanLines marks ALERGI notes as extra line', () => {
    const rows = hidanganInputFromPlanLines(
      [
        {
          recipeId: 'nasi',
          recipeKode: 'NASI',
          recipeNama: 'Nasi kunyit',
          targetPorsi: 12,
          kategoriPorsiList: ['PORSI_BESAR'],
        },
        {
          recipeId: 'tahu',
          recipeKode: 'TAHU',
          recipeNama: 'Tahu kukus',
          targetPorsi: 4,
          kategoriPorsiList: ['PORSI_BESAR'],
          notes: 'ALERGI: kacang',
        },
      ],
      recipesMap(recipeNasi(), {
        id: 'tahu',
        kode: 'TAHU',
        nama: 'Tahu kukus',
        aktif: true,
        kategoriMenu: 'LAUK_NABATI',
      }),
      ['PORSI_BESAR'],
    );
    expect(rows[0].slot).toBe('KARBOHIDRAT');
    expect(rows[0].isAlergi).toBeFalsy();
    expect(rows[1].slot).toBe('ALERGI');
    expect(rows[1].isAlergi).toBe(true);
    expect(rows[1].slotLabel).toBe('Alergi');
    expect(rows[1].targetPorsi).toBe(4);
  });

  it('empty BOM returns hidangan error and no rekap SKU', () => {
    const emptyRecipe: KebutuhanRecipeRef = {
      id: 'kosong',
      kode: 'KOSONG',
      nama: 'Tanpa bahan',
      aktif: true,
      kategoriMenu: 'GARNISH',
      yieldQty: 1,
      lines: [],
    };
    const built = buildKebutuhanBahanFromWeeklyDay({
      porsiByKategori: { ...emptyPortionTargets(), PORSI_BESAR: 10 },
      slots: { GARNISH: ['kosong'] },
      alergi: [],
    }, recipesMap(emptyRecipe));

    expect(built.hidangan).toHaveLength(1);
    expect(built.hidangan[0].error).toMatch(/belum punya bahan/i);
    expect(built.rekap).toEqual([]);
    expect(built.errors[0]).toMatch(/belum punya bahan/i);
    expect(built.acuanResep).toHaveLength(1);
    expect(built.acuanResep[0].error).toMatch(/belum punya bahan/i);
  });

  it('same SKU same satuan merges; GR vs KG stay separate rekap rows', () => {
    const nasi2: KebutuhanRecipeRef = {
      ...recipeNasi(),
      id: 'nasi-2',
      kode: 'NASI2',
      nama: 'Nasi 2',
    };
    const nasiKg: KebutuhanRecipeRef = {
      id: 'nasi-kg',
      kode: 'NASIKG',
      nama: 'Nasi kg',
      aktif: true,
      kategoriMenu: 'KARBOHIDRAT',
      yieldQty: 1,
      wastePct: 0,
      lines: [{
        productId: 'beras',
        productKode: 'BRS',
        productNama: 'Beras',
        qty: 1,
        qtyBesar: 1,
        pctKecil: 70,
        qtyKecil: 0.7,
        satuan: 'KG',
      }],
    };

    const merged = buildKebutuhanBahanFromWeeklyDay({
      porsiByKategori: { ...emptyPortionTargets(), PORSI_BESAR: 500 },
      slots: { KARBOHIDRAT: ['nasi', 'nasi-2'] },
      alergi: [],
    }, recipesMap(recipeNasi(), nasi2));
    expect(merged.rekap).toHaveLength(1);
    expect(merged.rekap[0].satuan).toBe('GR');
    expect(merged.rekap[0].sources).toHaveLength(2);
    expect(merged.rekap[0].qtyExact).toBeCloseTo(515 * 2, 1);

    const split = buildKebutuhanBahanHarian({
      hidangan: [
        {
          recipeId: 'nasi',
          slotLabel: 'Karbohidrat',
          targetPorsi: 500,
          kategoriPorsiList: ['PORSI_BESAR'],
        },
        {
          recipeId: 'nasi-kg',
          slotLabel: 'Karbohidrat',
          targetPorsi: 500,
          kategoriPorsiList: ['PORSI_BESAR'],
        },
      ],
      recipesById: recipesMap(recipeNasi(), nasiKg),
      acuanByKategori: { ...emptyPortionTargets(), PORSI_BESAR: 500 },
    });
    expect(split.rekap).toHaveLength(2);
    expect(split.rekap.map((r) => r.satuan).sort()).toEqual(['GR', 'KG']);
  });

  it('merges rekap when the same kode comes from different recipe catalog copies', () => {
    const a: KebutuhanRecipeRef = {
      id: 'soto',
      kode: 'SOTO',
      nama: 'Soto',
      aktif: true,
      kategoriMenu: 'LAUK_HEWANI',
      yieldQty: 1,
      wastePct: 0,
      lines: [{
        productId: 'serai-ani',
        productKode: 'B298819',
        productNama: 'Batang Serai',
        qty: 14,
        qtyBesar: 14,
        pctKecil: 100,
        qtyKecil: 14,
        satuan: 'ONS',
      }],
    };
    const b: KebutuhanRecipeRef = {
      id: 'tumis',
      kode: 'TUMIS',
      nama: 'Tumis',
      aktif: true,
      kategoriMenu: 'SAYUR',
      yieldQty: 1,
      wastePct: 0,
      lines: [{
        productId: 'serai-uddawam',
        productKode: 'B298819',
        productNama: 'Batang Serai',
        qty: 14,
        qtyBesar: 14,
        pctKecil: 100,
        qtyKecil: 14,
        satuan: 'ONS',
      }],
    };
    const built = buildKebutuhanBahanHarian({
      hidangan: [
        {
          recipeId: 'soto',
          slotLabel: 'Lauk',
          targetPorsi: 1,
          kategoriPorsiList: ['PORSI_BESAR'],
        },
        {
          recipeId: 'tumis',
          slotLabel: 'Sayur',
          targetPorsi: 1,
          kategoriPorsiList: ['PORSI_BESAR'],
        },
      ],
      recipesById: recipesMap(a, b),
      acuanByKategori: { ...emptyPortionTargets(), PORSI_BESAR: 1 },
    });
    expect(built.rekap).toHaveLength(1);
    expect(built.rekap[0].productKode).toBe('B298819');
    expect(built.rekap[0].sources).toHaveLength(2);
  });

  it('names the PDF file and watermarks unpublished drafts', () => {
    expect(acuanKerjaFileName('Dapur Pusat', TANGGAL)).toBe('Acuan-Kerja-Dapur-Pusat-2026-09-22');
    expect(acuanKerjaFileName('Dapur Pusat', TANGGAL, 'bahan')).toBe('Kebutuhan-Bahan-Dapur-Pusat-2026-09-22');
    expect(acuanKerjaFileName('', TANGGAL)).toBe('Acuan-Kerja-Dapur-2026-09-22');
    expect(acuanKerjaFileName('   ', TANGGAL)).toBe('Acuan-Kerja-Dapur-2026-09-22');
    expect(acuanKerjaDraftWatermark(undefined, undefined)).toBe(true);
    expect(acuanKerjaDraftWatermark('RPN-1', 'DRAFT')).toBe(true);
    expect(acuanKerjaDraftWatermark('RPN-1', 'SUBMITTED')).toBe(false);
    expect(acuanKerjaDraftWatermark('RPN-1', 'APPROVED')).toBe(false);
  });

  it('scales acuan resep cards to 500 porsi without gudang buffer', () => {
    const half = recipeNasi();
    half.yieldQty = 250;
    half.lines = [{
      productId: 'beras',
      productKode: 'BRS',
      productNama: 'Beras',
      qty: 250,
      qtyBesar: 250,
      pctKecil: 70,
      qtyKecil: 175,
      satuan: 'GR',
    }];
    const built = buildKebutuhanBahanFromWeeklyDay({
      porsiByKategori: { ...emptyPortionTargets(), PORSI_BESAR: 100 },
      slots: { KARBOHIDRAT: ['nasi'] },
      alergi: [{ recipeId: 'nasi', porsi: 2 }],
    }, recipesMap(half));
    expect(built.acuanResep).toHaveLength(1);
    expect(built.acuanResep[0].porsiAcuan).toBe(500);
    expect(built.acuanResep[0].lines[0].qtyBesar).toBe(500);
    expect(built.acuanResep[0].lines[0].qtyKecil).toBe(350);
  });

  it('dedupes acuan resep by recipeId and joins slot labels', () => {
    const built = buildKebutuhanBahanFromWeeklyDay({
      porsiByKategori: { ...emptyPortionTargets(), PORSI_BESAR: 10 },
      slots: { KARBOHIDRAT: ['nasi'], SAYUR: ['nasi'] },
      alergi: [{ recipeId: 'nasi', porsi: 2 }],
    }, recipesMap(recipeNasi()));
    expect(built.hidangan).toHaveLength(3);
    expect(built.acuanResep).toHaveLength(1);
    expect(built.acuanResep[0].slotLabel).toContain('Karbohidrat');
    expect(built.acuanResep[0].slotLabel).toContain('Sayur');
    expect(built.acuanResep[0].slotLabel).toContain('Alergi');
  });

  it('acuan resep ignores gudang buffer used by hidangan', () => {
    const built = buildKebutuhanBahanFromWeeklyDay({
      porsiByKategori: { ...emptyPortionTargets(), PORSI_BESAR: 100 },
      slots: { KARBOHIDRAT: ['nasi'] },
      alergi: [],
    }, recipesMap(recipeNasi()));
    expect(built.hidangan[0].lines[0].qtyBesarPart).toBeCloseTo(103, 1);
    expect(built.acuanResep[0].lines[0].qtyBesar).toBe(500);
    expect(built.acuanResep[0].lines[0].qtyBesar).not.toBeCloseTo(515, 0);
  });

  it('acuan resep cards missing recipes instead of dropping them', () => {
    const built = buildKebutuhanBahanFromWeeklyDay({
      porsiByKategori: { ...emptyPortionTargets(), PORSI_BESAR: 10 },
      slots: { KARBOHIDRAT: ['ghost'] },
      alergi: [],
    }, recipesMap());
    expect(built.acuanResep).toHaveLength(1);
    expect(built.acuanResep[0].recipeId).toBe('ghost');
    expect(built.acuanResep[0].error).toMatch(/tidak ditemukan/i);
  });

  it('susu pengecualian PCS: 2610 porsi × buffer 3% tanpa waste masak', () => {
    const susu: KebutuhanRecipeRef = {
      id: 'susu',
      kode: 'RSP-0010',
      nama: 'Susu Pasteurisasi 125 ml',
      aktif: true,
      kategoriMenu: 'SUSU',
      yieldQty: 500,
      wastePct: 1,
      lines: [{
        productId: 'susu-p',
        productKode: 'SUSU-125',
        productNama: 'Susu Pasteurisasi 125 ml',
        qty: 500,
        qtyBesar: 500,
        pctKecil: 70,
        qtyKecil: 350,
        satuan: 'PCS',
      }],
    };
    const built = buildKebutuhanBahanFromWeeklyDay({
      porsiByKategori: {
        ...emptyPortionTargets(),
        PORSI_BESAR: 1210,
        PORSI_KECIL: 1400,
      },
      slots: { SUSU: ['susu'] },
      alergi: [],
    }, recipesMap(susu), undefined, new Set(['SUSU-125']));

    expect(built.errors).toEqual([]);
    expect(built.hidangan[0].targetPorsi).toBe(2610);
    expect(built.hidangan[0].lines[0].qtyBesarPart).toBeCloseTo(1246.3, 1);
    expect(built.hidangan[0].lines[0].qtyKecilPart).toBeCloseTo(1442, 1);
    expect(built.rekap[0].qtyExact).toBeCloseTo(2688.3, 1);
    expect(built.rekap[0].qty).toBe(2689);
    expect(built.acuanResep).toHaveLength(1);
    expect(built.acuanResep[0].lines[0].qtyBesar).toBe(500);
    expect(built.acuanResep[0].lines[0].qtyKecil).toBe(500);
  });
});
