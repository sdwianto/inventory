import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HACCP_TEMPLATES,
  assertHaccpCanComplete,
  computeHaccpDisposition,
  effectiveHaccpDisposition,
  haccpDispositionMongoFilter,
  normalizeHaccpResultItems,
  type HaccpResultItem,
  type HaccpTemplateItem,
} from '@/lib/food-production/haccp';

const COOK_TPL = DEFAULT_HACCP_TEMPLATES[0].items;
const PHOTO = ['/api/media/t/x.jpg'];

function items(raw: Array<{ key: string; result: string }>, tpl = COOK_TPL): HaccpResultItem[] {
  const out = normalizeHaccpResultItems(raw, tpl);
  if ('error' in (out as object)) throw new Error((out as { error: string }).error);
  return out as HaccpResultItem[];
}

describe('ADR-004 P0B — disposition terpisah dari status dokumen', () => {
  it('semua CCP wajib PASS → PASS', () => {
    const all = items(COOK_TPL.map((t) => ({ key: t.key, result: 'PASS' })));
    expect(computeHaccpDisposition(all, COOK_TPL)).toBe('PASS');
  });

  it('satu CCP wajib FAIL → FAIL', () => {
    const one = items([
      { key: 'core_temp', result: 'FAIL' },
      { key: 'hold_time', result: 'PASS' },
      { key: 'thermometer_cal', result: 'PASS' },
    ]);
    expect(computeHaccpDisposition(one, COOK_TPL)).toBe('FAIL');
  });

  it('item non-critical yang gagal tidak menentukan disposition', () => {
    // Setelah P0C basisnya critical. Seed thermometer kini critical:true —
    // uji ini memakai template eksplisit non-critical agar kontrak P0B tetap jelas.
    const tpl: HaccpTemplateItem[] = [
      { key: 'core_temp', label: 'Suhu', required: true, critical: true, holdOnFail: true },
      { key: 'hold_time', label: 'Hold', required: true, critical: true, holdOnFail: true },
      { key: 'optional_note', label: 'Catatan', required: false, critical: false, holdOnFail: false },
    ];
    const nonCritical = items([
      { key: 'core_temp', result: 'PASS' },
      { key: 'hold_time', result: 'PASS' },
      { key: 'optional_note', result: 'FAIL' },
    ], tpl);
    expect(computeHaccpDisposition(nonCritical, tpl, 'CCP_COOK')).toBe('PASS');
  });

  it('masih ada CCP wajib NA → PENDING, bukan PASS dan bukan FAIL', () => {
    const partial = items([
      { key: 'core_temp', result: 'PASS' },
      { key: 'hold_time', result: 'NA' },
      { key: 'thermometer_cal', result: 'PASS' },
    ]);
    expect(computeHaccpDisposition(partial, COOK_TPL)).toBe('PENDING');
  });

  it('tanpa template, semua item dianggap kritis (arah aman)', () => {
    const raw: HaccpResultItem[] = [
      { key: 'a', label: 'A', result: 'PASS' },
      { key: 'b', label: 'B', result: 'FAIL' },
    ];
    expect(computeHaccpDisposition(raw, [])).toBe('FAIL');
    expect(computeHaccpDisposition(raw, undefined)).toBe('FAIL');
  });

  it('template tanpa item wajib → PASS, tidak menggantung', () => {
    const tpl: HaccpTemplateItem[] = [{ key: 'x', label: 'X', required: false }];
    const raw: HaccpResultItem[] = [{ key: 'x', label: 'X', result: 'FAIL' }];
    expect(computeHaccpDisposition(raw, tpl)).toBe('PASS');
  });
});

describe('ADR-004 P0B — CCP gagal tidak lagi menyandera dokumen', () => {
  const failed = items([
    { key: 'core_temp', result: 'FAIL' },
    { key: 'hold_time', result: 'PASS' },
    { key: 'thermometer_cal', result: 'PASS' },
  ]);

  it('dokumen dengan CCP wajib gagal boleh diselesaikan', () => {
    expect(assertHaccpCanComplete(failed, COOK_TPL, PHOTO)).toBeNull();
    expect(computeHaccpDisposition(failed, COOK_TPL)).toBe('FAIL');
  });

  it('CCP gagal tetap wajib melampirkan foto bila template memintanya', () => {
    // core_temp needsPhoto:true — justru kegagalan yang paling butuh bukti.
    expect(assertHaccpCanComplete(failed, COOK_TPL, [])).toMatch(/evidence foto/);
  });

  it('gate kelengkapan lain tetap berlaku', () => {
    const na = items([
      { key: 'core_temp', result: 'PASS' },
      { key: 'hold_time', result: 'NA' },
    ]);
    expect(assertHaccpCanComplete(na, COOK_TPL, PHOTO)).toMatch(/PASS\/FAIL/);
  });
});

describe('ADR-004 P0B — dokumen lama tanpa field disposition', () => {
  it('COMPLETED lama dibaca PASS karena gate lama menolak CCP wajib gagal', () => {
    expect(effectiveHaccpDisposition({
      status: 'COMPLETED',
      summary: { passCount: 3, failCount: 0, naCount: 0, requiredFailCount: 0, photoCount: 1 },
    })).toBe('PASS');
  });

  it('dokumen lama dengan requiredFailCount > 0 dibaca FAIL', () => {
    expect(effectiveHaccpDisposition({
      status: 'SUBMITTED',
      summary: { passCount: 1, failCount: 1, naCount: 0, requiredFailCount: 1, photoCount: 0 },
    })).toBe('FAIL');
  });

  it('dokumen lama yang belum selesai dibaca PENDING', () => {
    expect(effectiveHaccpDisposition({
      status: 'DRAFT',
      summary: { passCount: 0, failCount: 0, naCount: 3, requiredFailCount: 0, photoCount: 0 },
    })).toBe('PENDING');
    expect(effectiveHaccpDisposition(undefined)).toBe('PENDING');
  });

  it('field eksplisit selalu menang atas turunan', () => {
    expect(effectiveHaccpDisposition({
      disposition: 'FAIL',
      status: 'COMPLETED',
      summary: { passCount: 3, failCount: 0, naCount: 0, requiredFailCount: 0, photoCount: 1 },
    })).toBe('FAIL');
  });
});

describe('ADR-004 P0B — filter Mongo selaras dengan effectiveHaccpDisposition', () => {
  it('FAIL mencakup field eksplisit dan dokumen lama ber-requiredFailCount', () => {
    const f = haccpDispositionMongoFilter('FAIL');
    expect(f).toEqual({
      $or: [
        { disposition: 'FAIL' },
        { disposition: { $exists: false }, 'summary.requiredFailCount': { $gt: 0 } },
      ],
    });
  });

  it('PASS mencakup COMPLETED lama tanpa requiredFail, bukan equality mentah saja', () => {
    const f = haccpDispositionMongoFilter('PASS') as { $or: unknown[] };
    expect(f.$or).toEqual(
      expect.arrayContaining([
        { disposition: 'PASS' },
        expect.objectContaining({
          $and: expect.arrayContaining([
            { disposition: { $exists: false } },
            { status: 'COMPLETED' },
          ]),
        }),
      ]),
    );
  });

  it('PENDING tidak menarik COMPLETED lama', () => {
    const f = haccpDispositionMongoFilter('PENDING') as { $or: unknown[] };
    expect(JSON.stringify(f)).toContain('"$ne":"COMPLETED"');
    expect(JSON.stringify(f)).not.toContain('"failCount"');
  });
});
