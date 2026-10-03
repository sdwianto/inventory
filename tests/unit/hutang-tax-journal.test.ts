import { describe, expect, it } from 'vitest';
import {
  buildCreditNoteHutangJournalLines,
  buildDebitNoteHutangJournalLines,
  buildVendorHutangJournalLines,
} from '@/lib/api/journal-lines';
import { hutangPpnDikreditkan, journalMatchesBase } from '@/lib/api/hutang-vendor-journal';
import { resolveNotePpnPart } from '@/lib/api/hutang-from-vendor';
import type { JournalDetail } from '@/types/finance';

const sum = (lines: JournalDetail[], key: 'debet' | 'kredit') => lines.reduce((s, l) => s + l[key], 0);
const amt = (lines: JournalDetail[], kode: string) =>
  lines.filter((l) => l.rekeningKode === kode).reduce((s, l) => s + l.debet - l.kredit, 0);

describe('jurnal tagihan vendor PKP vs non-PKP', () => {
  it('PKP: PPN ke PPN Masukan', () => {
    const lines = buildVendorHutangJournalLines({ noDoc: 'INV', subTotal: 100000, ppn: 11000, total: 111000 });
    expect(amt(lines, '10410')).toBe(11000);
    expect(amt(lines, '10310')).toBe(100000);
    expect(sum(lines, 'debet')).toBe(sum(lines, 'kredit'));
  });

  it('non-PKP tanpa GRNI: PPN masuk Persediaan', () => {
    const lines = buildVendorHutangJournalLines({ noDoc: 'INV', subTotal: 100000, ppn: 0, ppnTidakDikreditkan: 11000, total: 111000 });
    expect(amt(lines, '10410')).toBe(0);
    expect(amt(lines, '10310')).toBe(111000);
    expect(sum(lines, 'debet')).toBe(sum(lines, 'kredit'));
  });

  it('non-PKP dengan akrual GRN: GRNI dikliring sebesar akrual, PPN ke Selisih Harga Beli', () => {
    const lines = buildVendorHutangJournalLines({
      noDoc: 'INV', subTotal: 100000, ppn: 0, ppnTidakDikreditkan: 11000, total: 111000, clearGrni: true, grniAmount: 100000,
    });
    expect(amt(lines, '20020')).toBe(100000);
    expect(amt(lines, '31030')).toBe(11000);
    expect(sum(lines, 'debet')).toBe(sum(lines, 'kredit'));
  });

  it('non-PKP costingV2 sebelum akrual GRN: GRNI hanya neto (tidak menyisakan PPN di GRNI)', () => {
    const lines = buildVendorHutangJournalLines({
      noDoc: 'INV', subTotal: 100000, ppn: 0, ppnTidakDikreditkan: 11000, total: 111000, clearGrni: true,
    });
    expect(amt(lines, '20020')).toBe(100000);
    expect(amt(lines, '31030')).toBe(11000);
  });

  it('hutang lama tanpa snapshot dianggap dikreditkan', () => {
    expect(hutangPpnDikreditkan({})).toBe(true);
    expect(hutangPpnDikreditkan({ ppnDikreditkan: false })).toBe(false);
  });

  it('journalMatchesBase memeriksa porsi PPN Masukan sesuai status PKP', () => {
    const base = { subTotal: 100000, ppn: 11000, total: 111000 };
    const pkp = { id: 'j', details: buildVendorHutangJournalLines({ noDoc: 'X', subTotal: 100000, ppn: 11000, total: 111000 }) };
    const nonPkp = { id: 'j', details: buildVendorHutangJournalLines({ noDoc: 'X', subTotal: 100000, ppnTidakDikreditkan: 11000, total: 111000 }) };
    expect(journalMatchesBase(pkp, base, true)).toBe(true);
    expect(journalMatchesBase(pkp, base, false)).toBe(false);
    expect(journalMatchesBase(nonPkp, base, false)).toBe(true);
    expect(journalMatchesBase(nonPkp, base, true)).toBe(false);
  });
});

describe('porsi PPN nota vendor', () => {
  const hutang = { ppn: 11000, total: 111000 };

  it('payload kontrak pajak (ber-ppnRate) memakai PPN nota dari vendor', () => {
    expect(resolveNotePpnPart({ ppn: 5000, ppnRate: 11 }, 55500, hutang)).toBe(5000);
    expect(resolveNotePpnPart({ ppn: 0, ppnRate: 11 }, 55500, hutang)).toBe(0);
  });

  it('payload lama memakai rasio PPN hutang', () => {
    expect(resolveNotePpnPart({ ppn: 0 }, 55500, hutang)).toBe(5500);
    expect(resolveNotePpnPart({}, 55500, { ppn: 0, total: 100000 })).toBe(0);
  });

  it('PPN nota tidak pernah melebihi nilai bruto nota', () => {
    expect(resolveNotePpnPart({ ppn: 99999, ppnRate: 11 }, 1000, hutang)).toBe(1000);
  });
});

describe('jurnal credit note vendor', () => {
  it('CN dalam sisa hutang: Dr Hutang / Cr Persediaan + PPN Masukan', () => {
    const lines = buildCreditNoteHutangJournalLines({ noDoc: 'CN', amount: 55500, ppn: 5500, invoiceTotal: 55500 });
    expect(amt(lines, '20010')).toBe(55500);
    expect(amt(lines, '10310')).toBe(-50000);
    expect(amt(lines, '10410')).toBe(-5500);
  });

  it('CN melebihi sisa hutang: kelebihan ke Piutang Vendor, jurnal tetap seimbang', () => {
    const lines = buildCreditNoteHutangJournalLines({
      noDoc: 'CN', amount: 55500, ppn: 5500, invoiceTotal: 55500, vendorCreditAmount: 20000,
    });
    expect(amt(lines, '20010')).toBe(35500);
    expect(amt(lines, '10250')).toBe(20000);
    expect(sum(lines, 'debet')).toBe(sum(lines, 'kredit'));
  });

  it('CN atas invoice lunas: seluruhnya Piutang Vendor, tanpa baris Hutang', () => {
    const lines = buildCreditNoteHutangJournalLines({ noDoc: 'CN', amount: 10000, vendorCreditAmount: 10000 });
    expect(lines.some((l) => l.rekeningKode === '20010')).toBe(false);
    expect(amt(lines, '10250')).toBe(10000);
  });

  it('non-PKP dengan transit retur: neto menutup transit, PPN ke Selisih Harga Beli (costingV2)', () => {
    const lines = buildCreditNoteHutangJournalLines({
      noDoc: 'CN', amount: 55500, ppn: 5500, invoiceTotal: 55500, clearTransit: true, ppnDikreditkan: false, costingV2: true,
    });
    expect(amt(lines, '10315')).toBe(-50000);
    expect(amt(lines, '31030')).toBe(-5500);
    expect(amt(lines, '10410')).toBe(0);
  });

  it('non-PKP tanpa transit: PPN ikut akun neto', () => {
    const lines = buildCreditNoteHutangJournalLines({
      noDoc: 'CN', amount: 55500, ppn: 5500, invoiceTotal: 55500, ppnDikreditkan: false,
    });
    expect(amt(lines, '10310')).toBe(-55500);
    expect(amt(lines, '10410')).toBe(0);
  });
});

describe('jurnal debit note vendor', () => {
  it('PPN nota eksplisit ke PPN Masukan', () => {
    const lines = buildDebitNoteHutangJournalLines({ noDoc: 'DN', amount: 11100, ppn: 1100, invoiceTotal: 11100 });
    expect(amt(lines, '10410')).toBe(1100);
    expect(amt(lines, '10310')).toBe(10000);
    expect(amt(lines, '20010')).toBe(-11100);
  });
});
