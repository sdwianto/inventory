import { describe, expect, it } from 'vitest';
import {
  buildGrnAccrualJournalLines,
  buildPenyesuaianJournalLines,
  buildVendorHutangJournalLines,
  buildHutangPaymentJournalLines,
  buildCreditNoteHutangJournalLines,
  buildVendorReturnTransitOutJournalLines,
  buildVendorReturnTransitRestoreJournalLines,
  reverseJournalDetails,
} from '@/lib/api/journal-lines';

describe('buildGrnAccrualJournalLines', () => {
  it('balances persediaan and GRNI', () => {
    const lines = buildGrnAccrualJournalLines({ noDoc: 'GRN1', subTotal: 100000 });
    const debet = lines.reduce((s, l) => s + l.debet, 0);
    const kredit = lines.reduce((s, l) => s + l.kredit, 0);
    expect(debet).toBe(kredit);
    expect(debet).toBe(100000);
  });
});

describe('buildVendorHutangJournalLines clearGrni', () => {
  it('clears GRNI instead of debiting persediaan again', () => {
    const lines = buildVendorHutangJournalLines({
      noDoc: 'INV1',
      subTotal: 100000,
      ppn: 11000,
      total: 111000,
      clearGrni: true,
    });
    expect(lines.some((l) => l.rekeningKode === '20020' && l.debet === 100000)).toBe(true);
    expect(lines.some((l) => l.rekeningKode === '10310')).toBe(false);
  });
});

describe('buildPenyesuaianJournalLines', () => {
  it('increase stock debits persediaan', () => {
    const lines = buildPenyesuaianJournalLines({ noDoc: 'PS1', amount: 5000, increase: true });
    expect(lines[0].rekeningKode).toBe('10310');
    expect(lines[0].debet).toBe(5000);
  });
});

describe('buildHutangPaymentJournalLines', () => {
  it('uses custom kas rekening when provided', () => {
    const lines = buildHutangPaymentJournalLines({
      noDoc: 'INV1',
      amount: 50000,
      metode: 'TUNAI',
      kasRekeningKode: '10120',
      kasRekeningNama: 'Bank BCA',
    });
    expect(lines[1].rekeningKode).toBe('10120');
    expect(lines[1].rekeningNama).toBe('Bank BCA');
    expect(lines[1].kredit).toBe(50000);
  });

  it('defaults transfer to Mandiri when no kas override', () => {
    const lines = buildHutangPaymentJournalLines({
      noDoc: 'INV2',
      amount: 10000,
      metode: 'TRANSFER',
    });
    expect(lines[1].rekeningKode).toBe('10110');
  });
});

describe('reverseJournalDetails', () => {
  it('swaps debet/kredit per line and keeps the journal balanced', () => {
    const original = buildVendorHutangJournalLines({
      noDoc: 'INV1',
      subTotal: 100000,
      ppn: 11000,
      total: 111000,
    });
    const reversed = reverseJournalDetails(original);

    const origDebet = original.reduce((s, l) => s + l.debet, 0);
    const origKredit = original.reduce((s, l) => s + l.kredit, 0);
    const revDebet = reversed.reduce((s, l) => s + l.debet, 0);
    const revKredit = reversed.reduce((s, l) => s + l.kredit, 0);

    expect(revDebet).toBe(origKredit);
    expect(revKredit).toBe(origDebet);
    expect(revDebet).toBe(revKredit);

    reversed.forEach((line, i) => {
      expect(line.debet).toBe(original[i].kredit);
      expect(line.kredit).toBe(original[i].debet);
      expect(line.rekeningKode).toBe(original[i].rekeningKode);
      expect(line.keterangan).toBe(`Void: ${original[i].keterangan}`);
    });
  });
});

describe('buildCreditNoteHutangJournalLines', () => {
  it('tanpa PPN — seluruh amount ke Persediaan (kompatibel mundur)', () => {
    const lines = buildCreditNoteHutangJournalLines({ noDoc: 'CN1', amount: 50000 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ rekeningKode: '20010', debet: 50000 });
    expect(lines[1]).toMatchObject({ rekeningKode: '10310', kredit: 50000 });
    const debet = lines.reduce((s, l) => s + l.debet, 0);
    const kredit = lines.reduce((s, l) => s + l.kredit, 0);
    expect(debet).toBe(kredit);
  });

  it('dengan PPN proporsional dari rasio hutang invoice', () => {
    // Invoice 111_000 = 100_000 + PPN 11_000; CN 55_500 → net 50_000 + PPN 5_500
    const lines = buildCreditNoteHutangJournalLines({
      noDoc: 'CN2',
      amount: 55500,
      ppn: 11000,
      invoiceTotal: 111000,
    });
    expect(lines.find((l) => l.rekeningKode === '20010')?.debet).toBe(55500);
    expect(lines.find((l) => l.rekeningKode === '10310')?.kredit).toBe(50000);
    expect(lines.find((l) => l.rekeningKode === '10410')?.kredit).toBe(5500);
    const debet = lines.reduce((s, l) => s + l.debet, 0);
    const kredit = lines.reduce((s, l) => s + l.kredit, 0);
    expect(debet).toBe(kredit);
  });

  it('PPN penuh bila amount = total invoice', () => {
    const lines = buildCreditNoteHutangJournalLines({
      noDoc: 'CN3',
      amount: 111000,
      ppn: 11000,
      invoiceTotal: 111000,
    });
    expect(lines.find((l) => l.rekeningKode === '10310')?.kredit).toBe(100000);
    expect(lines.find((l) => l.rekeningKode === '10410')?.kredit).toBe(11000);
  });

  it('clearTransit — Cr Barang dalam retur (10315) bukan Persediaan', () => {
    const lines = buildCreditNoteHutangJournalLines({
      noDoc: 'CN4',
      amount: 55500,
      ppn: 11000,
      invoiceTotal: 111000,
      clearTransit: true,
    });
    expect(lines.find((l) => l.rekeningKode === '10315')?.kredit).toBe(50000);
    expect(lines.find((l) => l.rekeningKode === '10310')).toBeUndefined();
    expect(lines.find((l) => l.rekeningKode === '10410')?.kredit).toBe(5500);
  });
});

describe('buildVendorReturnTransitOutJournalLines', () => {
  it('Dr transit / Cr Persediaan balance', () => {
    const lines = buildVendorReturnTransitOutJournalLines({ noDoc: 'RTV1', amount: 75000 });
    expect(lines[0]).toMatchObject({ rekeningKode: '10315', debet: 75000 });
    expect(lines[1]).toMatchObject({ rekeningKode: '10310', kredit: 75000 });
    expect(lines.reduce((s, l) => s + l.debet, 0)).toBe(lines.reduce((s, l) => s + l.kredit, 0));
  });
});

describe('buildVendorReturnTransitRestoreJournalLines', () => {
  it('Dr Persediaan / Cr transit balance', () => {
    const lines = buildVendorReturnTransitRestoreJournalLines({ noDoc: 'RTV1', amount: 25000, lineLabel: 'B1' });
    expect(lines[0]).toMatchObject({ rekeningKode: '10310', debet: 25000 });
    expect(lines[1]).toMatchObject({ rekeningKode: '10315', kredit: 25000 });
  });
});
