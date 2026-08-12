/**
 * ADR-004 Fase 4 — measuredValue auto-eval vs critical limit.
 */
import { describe, expect, it } from 'vitest';
import {
  applyMeasuredValueAutoEval,
  evaluateMeasuredValue,
  isNumericAutoEvalLimit,
  resolveTemplateCriticalLimit,
} from '@/lib/food-production/haccp-critical-limit-eval';
import {
  computeHaccpDisposition,
  listHaccpHoldFailLabels,
  normalizeHaccpResultItems,
  type HaccpTemplateItem,
} from '@/lib/food-production/haccp';

const TPL_COOK: HaccpTemplateItem[] = [
  {
    key: 'core_temp',
    label: 'Suhu inti',
    required: true,
    critical: true,
    holdOnFail: true,
    criticalLimit: {
      key: 'cl_core',
      parameter: 'core_temp',
      label: 'Suhu inti',
      operator: 'GTE',
      value: 74,
      unit: 'C',
    },
  },
  {
    key: 'visual',
    label: 'Inspeksi visual',
    required: true,
    critical: false,
  },
  {
    key: 'sop_text',
    label: 'Sesuai SOP',
    required: true,
    critical: true,
    holdOnFail: true,
    criticalLimitNote: 'sesuai SOP dapur',
  },
];

describe('ADR-004 Fase 4 — evaluateMeasuredValue', () => {
  const base = { key: 'a', parameter: 't', label: 't' as const };

  it('GTE / GT / LTE / LT / EQ / BETWEEN', () => {
    expect(evaluateMeasuredValue({ ...base, operator: 'GTE', value: 74 }, 74)).toBe('PASS');
    expect(evaluateMeasuredValue({ ...base, operator: 'GTE', value: 74 }, 73.9)).toBe('FAIL');
    expect(evaluateMeasuredValue({ ...base, operator: 'GT', value: 74 }, 74)).toBe('FAIL');
    expect(evaluateMeasuredValue({ ...base, operator: 'GT', value: 74 }, 74.1)).toBe('PASS');
    expect(evaluateMeasuredValue({ ...base, operator: 'LTE', value: 5 }, 5)).toBe('PASS');
    expect(evaluateMeasuredValue({ ...base, operator: 'LT', value: 5 }, 5)).toBe('FAIL');
    expect(evaluateMeasuredValue({ ...base, operator: 'EQ', value: 10 }, 10)).toBe('PASS');
    expect(evaluateMeasuredValue({ ...base, operator: 'EQ', value: 10 }, 11)).toBe('FAIL');
    expect(evaluateMeasuredValue({ ...base, operator: 'BETWEEN', value: 2, valueMax: 4 }, 3)).toBe('PASS');
    expect(evaluateMeasuredValue({ ...base, operator: 'BETWEEN', value: 2, valueMax: 4 }, 5)).toBe('FAIL');
  });

  it('TEXT tidak dievaluasi', () => {
    expect(evaluateMeasuredValue({ ...base, operator: 'TEXT', note: 'SOP' }, 1)).toEqual({
      error: expect.stringContaining('TEXT'),
    });
  });
});

describe('ADR-004 Fase 4 — resolve + autoEval', () => {
  it('resolve dari structured atau note', () => {
    expect(resolveTemplateCriticalLimit(TPL_COOK[0])?.operator).toBe('GTE');
    expect(resolveTemplateCriticalLimit({
      key: 'x',
      label: 'X',
      criticalLimitNote: '≤ 2 jam',
    })?.operator).toBe('LTE');
  });

  it('isNumericAutoEvalLimit false untuk TEXT', () => {
    expect(isNumericAutoEvalLimit(TPL_COOK[0])).toBe(true);
    expect(isNumericAutoEvalLimit(TPL_COOK[2])).toBe(false);
  });

  it('measuredValue + limit → auto PASS/FAIL; operatorId wajib', () => {
    const ok = applyMeasuredValueAutoEval(TPL_COOK[0], {
      measuredValue: 75,
      operatorId: 'u1',
      result: 'FAIL',
    });
    expect(ok).toMatchObject({
      result: 'PASS',
      autoEvaluated: true,
      measuredValue: 75,
      evaluatedLimitKey: 'cl_core',
    });

    const fail = applyMeasuredValueAutoEval(TPL_COOK[0], {
      measuredValue: 70,
      operatorId: 'u1',
    });
    expect(fail).toMatchObject({ result: 'FAIL', autoEvaluated: true });

    const noOp = applyMeasuredValueAutoEval(TPL_COOK[0], { measuredValue: 75 });
    expect(noOp).toEqual({ error: expect.stringContaining('operatorId') });
  });

  it('TEXT limit + measuredValue → result manual, autoEvaluated false', () => {
    const r = applyMeasuredValueAutoEval(TPL_COOK[2], {
      measuredValue: 1,
      operatorId: 'u1',
      result: 'PASS',
    });
    expect(r).toMatchObject({
      result: 'PASS',
      autoEvaluated: false,
      measuredValue: 1,
      operatorId: 'u1',
    });
  });

  it('tanpa limit → result manual; instrumentId opsional tersimpan', () => {
    const r = applyMeasuredValueAutoEval(TPL_COOK[1], {
      result: 'PASS',
      instrumentId: 'TH-01',
    });
    expect(r).toMatchObject({
      result: 'PASS',
      autoEvaluated: false,
      instrumentId: 'TH-01',
    });
  });
});

describe('ADR-004 Fase 4 — normalize + disposition/HOLD', () => {
  it('menghitung result dari measuredValue', () => {
    const items = normalizeHaccpResultItems([
      { key: 'core_temp', measuredValue: 80, operatorId: 'op-1', instrumentId: 'TH-9' },
      { key: 'visual', result: 'PASS' },
      { key: 'sop_text', result: 'PASS' },
    ], TPL_COOK);
    expect('error' in items).toBe(false);
    if ('error' in items) return;
    expect(items[0]).toMatchObject({
      result: 'PASS',
      autoEvaluated: true,
      measuredValue: 80,
      operatorId: 'op-1',
      instrumentId: 'TH-9',
      evaluatedLimitKey: 'cl_core',
    });
  });

  it('FAIL otomatis → disposition FAIL + hold candidate', () => {
    const items = normalizeHaccpResultItems([
      { key: 'core_temp', measuredValue: 60, operatorId: 'op-1', result: 'PASS' },
      { key: 'visual', result: 'NA' },
      { key: 'sop_text', result: 'PASS' },
    ], TPL_COOK);
    expect('error' in items).toBe(false);
    if ('error' in items) return;
    expect(items[0].result).toBe('FAIL');
    expect(items[0].autoEvaluated).toBe(true);
    expect(computeHaccpDisposition(items, TPL_COOK, 'CCP_COOK')).toBe('FAIL');
    expect(listHaccpHoldFailLabels(items, TPL_COOK, 'CCP_COOK')).toContain('Suhu inti');
  });
});
