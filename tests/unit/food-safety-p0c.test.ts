import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HACCP_TEMPLATES,
  computeHaccpDisposition,
  effectiveHaccpItemFlags,
  hasHaccpHoldCandidate,
  normalizeHaccpResultItems,
  normalizeHaccpTemplateItems,
  type HaccpResultItem,
  type HaccpTemplateItem,
} from '@/lib/food-production/haccp';
import { normalizeQcTemplateItems } from '@/lib/food-production/qc';

const COOK_TPL = DEFAULT_HACCP_TEMPLATES[0].items;
const COOK_CAT = DEFAULT_HACCP_TEMPLATES[0].category;

function items(raw: Array<{ key: string; result: string }>, tpl = COOK_TPL): HaccpResultItem[] {
  const out = normalizeHaccpResultItems(raw, tpl);
  if ('error' in (out as object)) throw new Error((out as { error: string }).error);
  return out as HaccpResultItem[];
}

describe('ADR-004 P0C — critical menggantikan required sebagai basis disposition', () => {
  it('critical+FAIL → disposition FAIL, meski required=false', () => {
    // thermometer_cal di seed: required:false, critical:true, holdOnFail:false
    const row = items([
      { key: 'core_temp', result: 'PASS' },
      { key: 'hold_time', result: 'PASS' },
      { key: 'thermometer_cal', result: 'FAIL' },
    ]);
    expect(computeHaccpDisposition(row, COOK_TPL, COOK_CAT)).toBe('FAIL');
    expect(hasHaccpHoldCandidate(row, COOK_TPL, COOK_CAT)).toBe(false);
  });

  it('holdOnFail+FAIL → disposition FAIL dan kandidat HOLD', () => {
    const row = items([
      { key: 'core_temp', result: 'FAIL' },
      { key: 'hold_time', result: 'PASS' },
      { key: 'thermometer_cal', result: 'PASS' },
    ]);
    expect(computeHaccpDisposition(row, COOK_TPL, COOK_CAT)).toBe('FAIL');
    expect(hasHaccpHoldCandidate(row, COOK_TPL, COOK_CAT)).toBe(true);
  });

  it('item non-critical FAIL tidak menentukan disposition', () => {
    const tpl: HaccpTemplateItem[] = [
      { key: 'a', label: 'A', required: true, critical: true, holdOnFail: true },
      { key: 'b', label: 'B', required: false, critical: false, holdOnFail: false },
    ];
    const row = items([
      { key: 'a', result: 'PASS' },
      { key: 'b', result: 'FAIL' },
    ], tpl);
    expect(computeHaccpDisposition(row, tpl, 'OTHER')).toBe('PASS');
    expect(hasHaccpHoldCandidate(row, tpl, 'OTHER')).toBe(false);
  });

  it('required kembali murni kelengkapan — tidak dipakai computeHaccpDisposition', () => {
    // Item required tapi critical=false (hanya sah di kategori non-CCP).
    const tpl: HaccpTemplateItem[] = [
      { key: 'label', label: 'Label', required: true, critical: false, holdOnFail: false },
    ];
    const row: HaccpResultItem[] = [{ key: 'label', label: 'Label', result: 'FAIL' }];
    expect(computeHaccpDisposition(row, tpl, 'OTHER')).toBe('PASS');
  });
});

describe('ADR-004 P0C — normalizer + invariansi CCP', () => {
  it('CCP wajib mendapat critical+holdOnFail secara default', () => {
    const items = normalizeHaccpTemplateItems(
      [{ key: 'core', label: 'Suhu inti' }],
      'CCP_COOK',
    );
    expect('error' in (items as object)).toBe(false);
    if ('error' in (items as object)) return;
    expect(items[0]).toMatchObject({
      required: true,
      critical: true,
      holdOnFail: true,
    });
  });

  it('menolak CCP wajib dengan holdOnFail=false', () => {
    const items = normalizeHaccpTemplateItems(
      [{ key: 'core', label: 'Suhu inti', holdOnFail: false }],
      'CCP_COOK',
    );
    expect(items).toEqual({ error: expect.stringMatching(/holdOnFail=false/) });
  });

  it('menolak CCP wajib dengan critical=false', () => {
    const items = normalizeHaccpTemplateItems(
      [{ key: 'core', label: 'Suhu inti', critical: false }],
      'CCP_COOK',
    );
    expect(items).toEqual({ error: expect.stringMatching(/critical=false/) });
  });

  it('holdOnFail=true tanpa critical di-upgrade menjadi critical', () => {
    const items = normalizeHaccpTemplateItems(
      [{ key: 'x', label: 'X', required: false, holdOnFail: true }],
      'OTHER',
    );
    expect('error' in (items as object)).toBe(false);
    if ('error' in (items as object)) return;
    expect(items[0].critical).toBe(true);
    expect(items[0].holdOnFail).toBe(true);
  });

  it('item non-wajib di CCP boleh critical tanpa hold', () => {
    const items = normalizeHaccpTemplateItems(
      [{ key: 'cal', label: 'Kalibrasi', required: false, critical: true, holdOnFail: false }],
      'CCP_COOK',
    );
    expect('error' in (items as object)).toBe(false);
    if ('error' in (items as object)) return;
    expect(items[0]).toMatchObject({ critical: true, holdOnFail: false });
  });

  it('QC default critical/holdOnFail mati', () => {
    const items = normalizeQcTemplateItems([{ key: 'a', label: 'A' }]);
    expect('error' in (items as object)).toBe(false);
    if ('error' in (items as object)) return;
    expect(items[0]).toMatchObject({ critical: false, holdOnFail: false });
  });
});

describe('ADR-004 P0C — legacy tanpa field flag', () => {
  it('CCP+required lama tanpa field dibaca critical+holdOnFail', () => {
    const flags = effectiveHaccpItemFlags({ required: true }, 'CCP_COOK');
    expect(flags).toEqual({ critical: true, holdOnFail: true });
  });

  it('OTHER lama tanpa field tidak kritis', () => {
    const flags = effectiveHaccpItemFlags({ required: true }, 'OTHER');
    expect(flags).toEqual({ critical: false, holdOnFail: false });
  });

  it('legacy CCP required tetap menghasilkan disposition FAIL', () => {
    const tpl: HaccpTemplateItem[] = [
      { key: 'core_temp', label: 'Suhu', required: true },
      { key: 'hold_time', label: 'Hold', required: true },
    ];
    const row = items([
      { key: 'core_temp', result: 'FAIL' },
      { key: 'hold_time', result: 'PASS' },
    ], tpl);
    expect(computeHaccpDisposition(row, tpl, 'CCP_COOK')).toBe('FAIL');
    expect(hasHaccpHoldCandidate(row, tpl, 'CCP_COOK')).toBe(true);
  });
});
