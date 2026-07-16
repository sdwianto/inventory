import { describe, expect, it } from 'vitest';
import {
  normalizeTempStage,
  normalizeSuhuC,
  normalizeThresholdNumbers,
  resolveThresholdBand,
  evaluateTempAlert,
  isOpenTempAlert,
  DEFAULT_TEMP_THRESHOLDS,
} from '@/lib/food-production/temperature-log';
import { FP_OPS_WRITE_ROLES, FP_MANAGE_ROLES } from '@/lib/food-production/roles';

describe('food-production phase 5 sprint 20', () => {
  it('normalizes stage and suhuC', () => {
    expect(normalizeTempStage('holding')).toBe('HOLDING');
    expect(normalizeTempStage('x')).toEqual({ error: expect.stringMatching(/stage/) });
    expect(normalizeSuhuC('74.26')).toBe(74.3);
    expect(normalizeSuhuC(null)).toEqual({ error: expect.stringMatching(/suhuC/) });
    expect(normalizeSuhuC(999)).toEqual({ error: expect.stringMatching(/rentang/) });
  });

  it('evaluates receiving cold chain alerts', () => {
    const band = resolveThresholdBand('RECEIVING');
    expect(evaluateTempAlert(2, band)).toBe('OK');
    expect(evaluateTempAlert(4.5, band)).toBe('WARN'); // near max 5
    expect(evaluateTempAlert(6, band)).toBe('OUT_OF_RANGE');
    expect(evaluateTempAlert(10, band)).toBe('CRITICAL');
    expect(evaluateTempAlert(-6, band)).toBe('CRITICAL');
  });

  it('evaluates cooking / holding hot thresholds', () => {
    expect(evaluateTempAlert(80, resolveThresholdBand('COOKING'))).toBe('OK');
    expect(evaluateTempAlert(72, resolveThresholdBand('COOKING'))).toBe('OUT_OF_RANGE');
    expect(evaluateTempAlert(60, resolveThresholdBand('COOKING'))).toBe('CRITICAL');
    expect(evaluateTempAlert(62, resolveThresholdBand('HOLDING'))).toBe('WARN');
    expect(evaluateTempAlert(70, resolveThresholdBand('HOLDING'))).toBe('OK');
  });

  it('merges tenant override onto defaults', () => {
    const band = resolveThresholdBand('HOLDING', { minC: 65 });
    expect(band.minC).toBe(65);
    expect(band.maxC).toBe(DEFAULT_TEMP_THRESHOLDS.HOLDING.maxC);
    expect(evaluateTempAlert(63, band)).toBe('OUT_OF_RANGE');
  });

  it('validates threshold numbers', () => {
    expect(normalizeThresholdNumbers({ minC: 10, maxC: 5 })).toEqual({
      error: expect.stringMatching(/minC/),
    });
    expect(normalizeThresholdNumbers({ minC: '1', maxC: '5', warnBandC: '0.5' })).toEqual({
      minC: 1,
      maxC: 5,
      warnBandC: 0.5,
    });
  });

  it('rejects non-finite one-off threshold overrides', () => {
    expect(normalizeThresholdNumbers({ minC: 'abc' })).toEqual({
      error: expect.stringMatching(/minC/),
    });
    expect(normalizeThresholdNumbers({ minC: 10, maxC: 5 })).toEqual({
      error: expect.stringMatching(/minC/),
    });
  });

  it('marks open alerts; ops write includes GUDANG', () => {
    expect(isOpenTempAlert('OK')).toBe(false);
    expect(isOpenTempAlert('WARN')).toBe(true);
    expect(isOpenTempAlert('CRITICAL')).toBe(true);
    expect(FP_OPS_WRITE_ROLES).toContain('GUDANG');
    expect(FP_MANAGE_ROLES).not.toContain('GUDANG');
  });
});
