import { describe, expect, it } from 'vitest';
import {
  buildCreditNoteHutangJournalLines,
  buildDebitNoteHutangJournalLines,
  buildVendorHutangJournalLines,
  COA,
} from '@/lib/api/journal-lines';
import { journalMatchesBase } from '@/lib/api/hutang-vendor-journal';
import { buildConsumptionJournalLines, postedLinesValue } from '@/lib/api/stock-cost-journal';

const sum = (lines: Array<{ debet: number; kredit: number }>) => ({
  debet: lines.reduce((s, l) => s + l.debet, 0),
  kredit: lines.reduce((s, l) => s + l.kredit, 0),
});

describe('Fase 4 — jurnal nilai persediaan', () => {
  it('nilai baris kartu: |qty| × harga, barang memo tidak ikut', () => {
    expect(postedLinesValue([
      { deltaQtyBase: -2.5, unitCost: 1234.5678, costSource: 'AVG' },
      { deltaQtyBase: -1, unitCost: 9999, costSource: 'NON_INVENTORY' },
      { deltaQtyBase: 3, unitCost: 100, costSource: 'LINE' },
    ])).toBe(3386.42);
  });

  it('pemakaian bahan: Dr Beban Bahan Baku, Cr Persediaan, dibulatkan rupiah', () => {
    const lines = buildConsumptionJournalLines({ noDoc: 'RL-1', amount: 3086.42 });
    expect(lines.map((l) => [l.rekeningKode, l.debet, l.kredit])).toEqual([
      [COA.BEBAN_BAHAN.kode, 3086, 0],
      [COA.PERSEDIAAN.kode, 0, 3086],
    ]);
    expect(buildConsumptionJournalLines({ noDoc: 'RL-0', amount: 0.4 })).toEqual([]);
  });

  it('kliring GRNI pada nilai akrual; invoice lebih mahal → Dr Selisih Harga Beli', () => {
    const lines = buildVendorHutangJournalLines({
      noDoc: 'INV-1', subTotal: 105_000, ppn: 11_550, total: 116_550, clearGrni: true, grniAmount: 100_000,
    });
    expect(lines.map((l) => [l.rekeningKode, l.debet, l.kredit])).toEqual([
      [COA.GRNI.kode, 100_000, 0],
      [COA.SELISIH_HARGA_BELI.kode, 5_000, 0],
      [COA.PPN_MASUKAN.kode, 11_550, 0],
      [COA.HUTANG.kode, 0, 116_550],
    ]);
    expect(sum(lines)).toEqual({ debet: 116_550, kredit: 116_550 });
  });

  it('invoice lebih murah → Cr Selisih Harga Beli; cek nilai tagihan tetap pakai baris Hutang', () => {
    const details = buildVendorHutangJournalLines({
      noDoc: 'INV-2', subTotal: 95_000, total: 95_000, clearGrni: true, grniAmount: 100_000,
    });
    expect(details.find((l) => l.rekeningKode === COA.SELISIH_HARGA_BELI.kode)).toMatchObject({ debet: 0, kredit: 5_000 });
    const t = sum(details);
    expect(t).toEqual({ debet: 100_000, kredit: 100_000 });
    const journal = { id: 'j', details, totalDebet: t.debet };
    expect(journalMatchesBase(journal, { subTotal: 95_000, ppn: 0, total: 95_000 })).toBe(true);
    expect(journalMatchesBase(journal, { subTotal: 100_000, ppn: 0, total: 100_000 })).toBe(false);
  });

  it('DN / CN harga saat costingV2: Selisih Harga Beli; retur transit tetap 10315; default tetap Persediaan', () => {
    const dn = buildDebitNoteHutangJournalLines({ noDoc: 'DN-1', amount: 11_100, ppn: 1_100, invoiceTotal: 11_100, priceVariance: true });
    expect(dn.map((l) => [l.rekeningKode, l.debet, l.kredit])).toEqual([
      [COA.SELISIH_HARGA_BELI.kode, 10_000, 0],
      [COA.PPN_MASUKAN.kode, 1_100, 0],
      [COA.HUTANG.kode, 0, 11_100],
    ]);
    expect(buildDebitNoteHutangJournalLines({ noDoc: 'DN-2', amount: 5_000 })[0].rekeningKode).toBe(COA.PERSEDIAAN.kode);

    const inv = (l: Array<{ rekeningKode: string; kredit: number }>) => l.filter((x) => x.kredit > 0 && x.rekeningKode !== COA.PPN_MASUKAN.kode).map((x) => x.rekeningKode);
    expect(inv(buildCreditNoteHutangJournalLines({ noDoc: 'CN-1', amount: 5_000, priceVariance: true }))).toEqual([COA.SELISIH_HARGA_BELI.kode]);
    expect(inv(buildCreditNoteHutangJournalLines({ noDoc: 'CN-2', amount: 5_000, clearTransit: true, priceVariance: true }))).toEqual([COA.BARANG_DALAM_RETUR.kode]);
    expect(inv(buildCreditNoteHutangJournalLines({ noDoc: 'CN-3', amount: 5_000 }))).toEqual([COA.PERSEDIAAN.kode]);
  });

  it('tanpa nilai akrual: perilaku lama (Dr GRNI = subTotal, tanpa PPV)', () => {
    const lines = buildVendorHutangJournalLines({ noDoc: 'INV-3', subTotal: 50_000, total: 50_000, clearGrni: true });
    expect(lines.map((l) => l.rekeningKode)).toEqual([COA.GRNI.kode, COA.HUTANG.kode]);
  });
});
