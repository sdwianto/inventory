import { describe, expect, it } from 'vitest';
import {
  extractCounterpartyFromDescription,
  parseBniMutasiCsv,
} from '@/lib/people/bni-mutasi-parse';
import { parseRupiahAmount, normalizeTxnDate } from '@/lib/people/person-payment';

const FIXTURE_3 = [
  'Tanggal;Keterangan;Debet;Kredit;Saldo;NTB',
  '05/03/2029;TRANSFER INHOUSE BNI 1122334455 AN. SITI AMINAH;1.500.000;0;98.500.000;NTB001INHOUSE',
  '05/03/2029;BI FAST KE BUDI SANTOSO;750.000;0;97.750.000;NTB002BIFAST',
  '05/03/2029;KREDIT BUNGA;0;25.000;97.775.000;NTB003KREDIT',
].join('\n');

describe('parseRupiahAmount / normalizeTxnDate', () => {
  it('parses Indonesian thousand separators as integer rupiah', () => {
    expect(parseRupiahAmount('1.500.000')).toBe(1_500_000);
    expect(parseRupiahAmount('750.000')).toBe(750_000);
    expect(parseRupiahAmount('1,500,000.00')).toBe(1_500_000);
  });

  it('normalizes D/M/YYYY to ISO date', () => {
    expect(normalizeTxnDate('05/03/2029')).toBe('2029-03-05');
    expect(normalizeTxnDate('2029-03-05')).toBe('2029-03-05');
    expect(normalizeTxnDate('05-Mar-2029')).toBe('2029-03-05');
    expect(normalizeTxnDate('5 Maret 2029')).toBe('2029-03-05');
    expect(normalizeTxnDate('')).toBe(null);
  });
});

describe('extractCounterpartyFromDescription', () => {
  it('extracts norek, bank, and AN. name from inhouse BNI', () => {
    const hit = extractCounterpartyFromDescription('TRANSFER INHOUSE BNI 1122334455 AN. SITI AMINAH');
    expect(hit.account).toBe('1122334455');
    expect(hit.bank).toBe('BNI');
    expect(hit.name).toBe('SITI AMINAH');
  });

  it('does not invent an account for BI FAST nama-only', () => {
    const hit = extractCounterpartyFromDescription('BI FAST KE BUDI SANTOSO');
    expect(hit.account).toBeUndefined();
  });

  it('prefers destination bank/norek over origin BNI and leading origin norek', () => {
    const hit = extractCounterpartyFromDescription(
      'TRANSFER BNI 101301111111 KE BCA 1234567890 AN. SITI AMINAH',
    );
    expect(hit.bank).toBe('BCA');
    expect(hit.account).toBe('1234567890');
    expect(hit.name).toBe('SITI AMINAH');
  });
});

describe('parseBniMutasiCsv', () => {
  it('keeps two debits and skips kredit noise from the 3-row BNI fixture', () => {
    const parsed = parseBniMutasiCsv(FIXTURE_3);
    expect(parsed.rows).toHaveLength(2);

    const inhouse = parsed.rows[0];
    expect(inhouse.amount).toBe(1_500_000);
    expect(inhouse.valueDate).toBe('2029-03-05');
    expect(inhouse.bankRef).toBe('NTB001INHOUSE');
    expect(inhouse.counterpartyAccount).toBe('1122334455');
    expect(inhouse.counterpartyBank).toBe('BNI');
    expect(inhouse.counterpartyName).toBe('SITI AMINAH');

    const bifast = parsed.rows[1];
    expect(bifast.amount).toBe(750_000);
    expect(bifast.bankRef).toBe('NTB002BIFAST');
    expect(bifast.counterpartyAccount).toBeUndefined();
    expect(parsed.rows.some((r) => r.bankRef === 'NTB003KREDIT')).toBe(false);
  });

  it('detects comma delimiter and keeps the same NTB for idempotency', () => {
    const csv = [
      'Tanggal,Keterangan,Debet,Kredit,Saldo,No. Ref',
      '05/03/2029,TRANSFER KE BCA 1234567890 AN. SITI AMINAH,"1,500,000",0,"10,000,000",NTB001INHOUSE',
    ].join('\n');
    const parsed = parseBniMutasiCsv(csv);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].bankRef).toBe('NTB001INHOUSE');
    expect(parsed.rows[0].counterpartyBank).toBe('BCA');
    expect(parsed.rows[0].counterpartyAccount).toBe('1234567890');
  });

  it('re-parsing the same NTB yields the same bankRef', () => {
    const a = parseBniMutasiCsv(FIXTURE_3);
    const b = parseBniMutasiCsv(FIXTURE_3);
    expect(a.rows.map((r) => r.bankRef)).toEqual(b.rows.map((r) => r.bankRef));
  });

  it('reads origin rekening column and date with English month', () => {
    const csv = [
      'Tanggal Transaksi;Keterangan;Debet;Kredit;Saldo;NTB;No. Rekening',
      '05-Mar-2029;TRANSFER KE BCA 1234567890 AN. SITI;1.500.000;0;0;NTB099;8888888888',
    ].join('\n');
    const parsed = parseBniMutasiCsv(csv);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].valueDate).toBe('2029-03-05');
    expect(parsed.rows[0].accountNo).toBe('8888888888');
    expect(parsed.rows[0].counterpartyBank).toBe('BCA');
    expect(parsed.rows[0].counterpartyAccount).toBe('1234567890');
  });

  it('synthesizes a stable BNI- ref when NTB is empty', () => {
    const csv = [
      'Tanggal;Keterangan;Debet;Kredit;Saldo',
      '05/03/2029;TRANSFER INHOUSE BNI 1122334455;1500000;0;0',
    ].join('\n');
    const a = parseBniMutasiCsv(csv);
    const b = parseBniMutasiCsv(csv);
    expect(a.rows[0].bankRef).toMatch(/^BNI-[0-9A-F]{16}$/);
    expect(a.rows[0].bankRef).toBe(b.rows[0].bankRef);
  });
});
