import { describe, expect, it } from 'vitest';
import { recipeIngredientNeeds } from '@/lib/food-production/rencana-kebutuhan';
import { buildAcuanResepCards } from '@/lib/food-production/kebutuhan-bahan-harian';
import {
  DEFAULT_PCT_KECIL,
  applySppgPortionStandards,
  normalizeRecipeLines,
} from '@/lib/food-production/recipe';

const BESAR = 1243;
const KECIL = 1388;

describe('standar porsi SPPG', () => {
  it('default porsi kecil adalah 100%', () => {
    expect(DEFAULT_PCT_KECIL).toBe(100);
    const lines = normalizeRecipeLines([{ productId: 'p1', qtyBesar: 10, satuan: 'KG' }]);
    expect(lines).toEqual([
      expect.objectContaining({ pctKecil: 100, qtyKecil: 10, qtyBesar: 10 }),
    ]);
  });

  it('beras 55 g besar dan 45 g kecil, sebelum buffer', () => {
    const [beras] = applySppgPortionStandards([{
      productId: 'beras',
      productNama: 'Beras Dua Strawbery',
      qty: 28,
      qtyBesar: 28,
      pctKecil: 70,
      qtyKecil: 19.6,
      satuan: 'KG',
      qtyBaseBesar: 28,
      qtyBaseKecil: 19.6,
      factorToBase: 1,
      baseSatuan: 'KG',
    }], 500);
    expect(beras.qtyBesar).toBe(27.5);
    expect(beras.qtyKecil).toBe(22.5);
    expect(beras.qtyBaseBesar).toBe(27.5);
    expect(beras.qtyBaseKecil).toBe(22.5);

    const needs = recipeIngredientNeeds({
      recipe: { yieldQty: 500, wastePct: 0, lines: [beras] },
      menuTargetPorsi: BESAR + KECIL,
      recipePerMenuPorsi: 1,
      kategoriPorsiList: ['PORSI_BESAR', 'PORSI_KECIL'],
      acuanByKategori: { PORSI_BESAR: BESAR, PORSI_KECIL: KECIL },
    });
    expect(needs[0].qtyBesarPart).toBeCloseTo(68.365, 3);
    expect(needs[0].qtyKecilPart).toBeCloseTo(62.46, 3);
  });

  it('kelengkeng tampil PCS: 4 besar + 3 kecil, basis 100 pcs = 1 kg', () => {
    const [buah] = applySppgPortionStandards([{
      productId: 'klk',
      productNama: 'Klengkeng Super',
      qty: 20,
      qtyBesar: 20,
      pctKecil: 70,
      qtyKecil: 14,
      satuan: 'KG',
      qtyBaseBesar: 20,
      qtyBaseKecil: 14,
      factorToBase: 1,
      baseSatuan: 'KG',
    }], 500);
    expect(buah.satuan).toBe('PCS');
    expect(buah.qtyBesar).toBe(2000);
    expect(buah.qtyKecil).toBe(1500);
    expect(buah.qtyBaseBesar).toBeCloseTo(20);
    expect(buah.qtyBaseKecil).toBeCloseTo(15);

    const needs = recipeIngredientNeeds({
      recipe: { yieldQty: 500, wastePct: 1, lines: [buah] },
      menuTargetPorsi: BESAR + KECIL,
      recipePerMenuPorsi: 1,
      kategoriPorsiList: ['PORSI_BESAR', 'PORSI_KECIL'],
      acuanByKategori: { PORSI_BESAR: BESAR, PORSI_KECIL: KECIL },
    });
    expect(needs[0].satuan).toBe('PCS');
    expect((needs[0].qtyBesarPart || 0) + (needs[0].qtyKecilPart || 0)).toBeCloseTo(9136, 3);

    const cards = buildAcuanResepCards(
      [{ recipeId: 'r1', recipeNama: 'Kelengkeng', slotLabel: 'Buah' }],
      new Map([['r1', {
        id: 'r1',
        kode: 'RSP-0016',
        nama: 'Kelengkeng',
        aktif: true,
        yieldQty: 500,
        lines: [buah],
      }]]),
    );
    expect(cards[0].lines[0].satuan).toBe('PCS');
    expect(cards[0].lines[0].qtyBesar).toBe(2000);
    expect(cards[0].lines[0].qtyKecil).toBe(1500);
  });

  it('ayam potong 1 per penerima, waste tidak mengurangi, buffer 3% di atasnya', () => {
    const [ayam] = applySppgPortionStandards([{
      productId: 'ayam',
      productNama: 'Daging Ayam Potongan 10',
      qty: 50,
      qtyBesar: 50,
      pctKecil: 70,
      qtyKecil: 35,
      satuan: 'KG',
      qtyBaseBesar: 500,
      qtyBaseKecil: 350,
      baseSatuan: 'ONS',
    }], 500);
    expect(ayam.satuan).toBe('Potong');
    expect(ayam.qtyBesar).toBe(500);
    expect(ayam.qtyKecil).toBe(500);
    expect(ayam.qtyBaseBesar).toBe(500);
    expect(ayam.qtyBaseKecil).toBe(500);

    const before = recipeIngredientNeeds({
      recipe: { yieldQty: 500, wastePct: 1, lines: [ayam] },
      menuTargetPorsi: BESAR + KECIL,
      recipePerMenuPorsi: 1,
      kategoriPorsiList: ['PORSI_BESAR', 'PORSI_KECIL'],
      acuanByKategori: { PORSI_BESAR: BESAR, PORSI_KECIL: KECIL },
    });
    expect(before[0].satuan).toBe('Potong');
    expect((before[0].qtyBesarPart || 0) + (before[0].qtyKecilPart || 0)).toBeCloseTo(2631, 3);

    const buffered = recipeIngredientNeeds({
      recipe: { yieldQty: 500, wastePct: 1, lines: [ayam] },
      menuTargetPorsi: BESAR + KECIL,
      recipePerMenuPorsi: 1,
      kategoriPorsiList: ['PORSI_BESAR', 'PORSI_KECIL'],
      acuanByKategori: { PORSI_BESAR: BESAR, PORSI_KECIL: KECIL },
      bufferPct: 3,
    });
    expect(buffered[0].qty).toBe(2710);
  });

  it('bahan biasa naik ke 100%, bumbu ayam tidak jadi potong', () => {
    const [pakcoy, minyak, knoor, sudahPenuh] = applySppgPortionStandards([
      {
        productId: 'pakcoy',
        productNama: 'Pakcoy',
        qty: 8,
        qtyBesar: 8,
        pctKecil: 70,
        qtyKecil: 5.6,
        satuan: 'KG',
        qtyBaseBesar: 8,
        qtyBaseKecil: 5.6,
      },
      {
        productId: 'minyak',
        productNama: 'Minyak Goreng',
        qty: 18,
        qtyBesar: 18,
        pctKecil: 80,
        qtyKecil: 14.4,
        satuan: 'L',
      },
      {
        productId: 'knoor',
        productNama: 'Knoor Ayam',
        qty: 0.5,
        qtyBesar: 0.5,
        pctKecil: 70,
        qtyKecil: 0.35,
        satuan: 'KG',
      },
      {
        productId: 'garam',
        productNama: 'Garam',
        qty: 1,
        qtyBesar: 1,
        pctKecil: 100,
        qtyKecil: 1,
        satuan: 'KG',
      },
    ], 500);
    expect(pakcoy.qtyKecil).toBe(pakcoy.qtyBesar);
    expect(pakcoy.pctKecil).toBe(100);
    expect(pakcoy.qtyBaseKecil).toBe(8);
    expect(minyak.qtyKecil).toBe(minyak.qtyBesar);
    expect(minyak.pctKecil).toBe(100);
    expect(knoor.satuan).toBe('KG');
    expect(knoor.qtyKecil).toBe(0.5);
    expect(sudahPenuh.qtyKecil).toBe(1);
  });
});
