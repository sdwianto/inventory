/**
 * ADR-004 Fase 4 — evaluasi measuredValue terhadap critical limit terstruktur.
 * Menggantikan operator yang mengetik PASS/FAIL sendiri bila limit numerik tersedia.
 */

import type { CriticalLimitOperator, HaccpCriticalLimit } from '@/lib/food-production/haccp-plan';
import { parseCriticalLimitNote } from '@/lib/food-production/haccp-plan';
import type { HaccpItemResult, HaccpTemplateItem } from '@/lib/food-production/haccp';

export type CriticalLimitLike = Pick<
  HaccpCriticalLimit,
  'operator' | 'value' | 'valueMax' | 'unit' | 'note' | 'parameter' | 'label' | 'key'
>;

/** Input longgar — UI/API sering kirim criticalLimit parsial tanpa key/parameter. */
export type TemplateLimitSource = {
  key: string;
  label: string;
  criticalLimitNote?: string | null;
  criticalLimit?: {
    key?: string;
    parameter?: string;
    label?: string;
    operator?: string;
    value?: number;
    valueMax?: number;
    unit?: string;
    durationMinutes?: number;
    note?: string;
  } | null;
};

/**
 * Resolve limit dari template item: structured dulu, lalu parse note legacy.
 */
export function resolveTemplateCriticalLimit(
  item: TemplateLimitSource,
): CriticalLimitLike | null {
  const cl = item.criticalLimit;
  if (cl && cl.operator) {
    const op = String(cl.operator).toUpperCase() as CriticalLimitOperator;
    return {
      key: cl.key || item.key,
      parameter: cl.parameter || 'value',
      label: cl.label || item.label,
      operator: op,
      value: cl.value,
      valueMax: cl.valueMax,
      unit: cl.unit,
      note: cl.note || item.criticalLimitNote || undefined,
    };
  }
  const note = String(item.criticalLimitNote || '').trim();
  if (!note) return null;
  return parseCriticalLimitNote(note, {
    key: `cl_${item.key}`,
    parameter: 'value',
    label: item.label,
  });
}

/** True bila limit numerik bisa auto-eval (bukan TEXT). */
export function isNumericAutoEvalLimit(item: TemplateLimitSource): boolean {
  const limit = resolveTemplateCriticalLimit(item);
  if (!limit) return false;
  return String(limit.operator || '').toUpperCase() !== 'TEXT';
}

/**
 * Bandingkan angka terhadap operator. TEXT tidak dievaluasi numerik.
 */
export function evaluateMeasuredValue(
  limit: CriticalLimitLike,
  measuredValue: number,
): HaccpItemResult | { error: string } {
  if (!Number.isFinite(measuredValue)) {
    return { error: 'measuredValue harus angka valid' };
  }
  const op = String(limit.operator || '').toUpperCase() as CriticalLimitOperator;
  if (op === 'TEXT') {
    return { error: 'Critical limit TEXT tidak dievaluasi otomatis — isi result manual' };
  }
  const v = limit.value;
  if (op !== 'BETWEEN' && (v == null || Number.isNaN(Number(v)))) {
    return { error: 'Critical limit numerik tanpa value' };
  }
  switch (op) {
    case 'GTE':
      return measuredValue >= Number(v) ? 'PASS' : 'FAIL';
    case 'GT':
      return measuredValue > Number(v) ? 'PASS' : 'FAIL';
    case 'LTE':
      return measuredValue <= Number(v) ? 'PASS' : 'FAIL';
    case 'LT':
      return measuredValue < Number(v) ? 'PASS' : 'FAIL';
    case 'EQ':
      return measuredValue === Number(v) ? 'PASS' : 'FAIL';
    case 'BETWEEN': {
      if (v == null || limit.valueMax == null || Number.isNaN(Number(limit.valueMax))) {
        return { error: 'BETWEEN butuh value dan valueMax' };
      }
      const lo = Math.min(Number(v), Number(limit.valueMax));
      const hi = Math.max(Number(v), Number(limit.valueMax));
      return measuredValue >= lo && measuredValue <= hi ? 'PASS' : 'FAIL';
    }
    default:
      return { error: `operator tidak dikenal: ${op}` };
  }
}

export interface AutoEvalInput {
  measuredValue?: unknown;
  operatorId?: unknown;
  instrumentId?: unknown;
  /** Result manual dari client — diabaikan bila auto-eval berhasil. */
  result?: unknown;
}

export interface AutoEvalOutput {
  result: HaccpItemResult;
  measuredValue?: number;
  operatorId?: string;
  instrumentId?: string;
  /** true bila result berasal dari evaluasi limit. */
  autoEvaluated: boolean;
  evaluatedLimitKey?: string;
}

/**
 * Terapkan auto-eval untuk satu item template.
 * - Ada measuredValue + limit numerik → result dari evaluasi; operatorId wajib.
 * - Tanpa measuredValue / tanpa limit → result manual (PASS|FAIL|NA).
 */
export function applyMeasuredValueAutoEval(
  templateItem: HaccpTemplateItem,
  input: AutoEvalInput,
): AutoEvalOutput | { error: string } {
  const limit = resolveTemplateCriticalLimit(templateItem);
  const hasMeasured = input.measuredValue != null && String(input.measuredValue).trim() !== '';
  const resultRaw = String(input.result || 'NA').toUpperCase();
  const manualResult: HaccpItemResult =
    resultRaw === 'PASS' || resultRaw === 'FAIL' || resultRaw === 'NA' ? resultRaw : 'NA';

  const operatorId = String(input.operatorId || '').trim() || undefined;
  const instrumentId = String(input.instrumentId || '').trim() || undefined;

  if (!hasMeasured || !limit) {
    if (hasMeasured) {
      const measured = Number(input.measuredValue);
      if (!Number.isFinite(measured)) {
        return { error: `Item "${templateItem.label}": measuredValue harus angka` };
      }
      if (!operatorId) {
        return { error: `Item "${templateItem.label}": operatorId wajib bila measuredValue diisi` };
      }
      return {
        result: manualResult,
        measuredValue: measured,
        operatorId,
        instrumentId,
        autoEvaluated: false,
      };
    }
    return {
      result: manualResult,
      operatorId,
      instrumentId,
      autoEvaluated: false,
    };
  }

  const measured = Number(input.measuredValue);
  if (!Number.isFinite(measured)) {
    return { error: `Item "${templateItem.label}": measuredValue harus angka` };
  }
  if (!operatorId) {
    return { error: `Item "${templateItem.label}": operatorId wajib bila measuredValue diisi` };
  }

  const evaluated = evaluateMeasuredValue(limit, measured);
  if (typeof evaluated !== 'string') {
    // TEXT / limit invalid → jangan paksa; jatuh ke manual tapi simpan measured.
    if (limit.operator === 'TEXT' || String(limit.operator).toUpperCase() === 'TEXT') {
      return {
        result: manualResult,
        measuredValue: measured,
        operatorId,
        instrumentId,
        autoEvaluated: false,
        evaluatedLimitKey: limit.key,
      };
    }
    return { error: `Item "${templateItem.label}": ${evaluated.error}` };
  }

  return {
    result: evaluated,
    measuredValue: measured,
    operatorId,
    instrumentId,
    autoEvaluated: true,
    evaluatedLimitKey: limit.key,
  };
}
