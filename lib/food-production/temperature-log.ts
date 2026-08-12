/**
 * Cold-chain temperature logs + alert — ADR-001 Phase 5 / Sprint 20.
 * Log suhu receiving / cooking / holding; threshold + alertStatus at write-time.
 */

export const TEMPERATURE_LOGS_COLLECTION = 'temperature_logs';
export const TEMPERATURE_THRESHOLDS_COLLECTION = 'temperature_thresholds';

export type TempStage = 'RECEIVING' | 'COOKING' | 'HOLDING';
export type TempAlertStatus = 'OK' | 'WARN' | 'OUT_OF_RANGE' | 'CRITICAL';

export interface TempThresholdBand {
  minC?: number;
  maxC?: number;
  /** Degrees inside band that trigger WARN near edges. */
  warnBandC?: number;
  /** Degrees outside band that escalate OUT_OF_RANGE → CRITICAL. */
  criticalMarginC?: number;
}

export interface TemperatureThresholdDoc {
  id: string;
  tenantId: string;
  stage: TempStage;
  minC?: number;
  maxC?: number;
  warnBandC?: number;
  criticalMarginC?: number;
  catatan?: string;
  updatedAt: Date;
  createdAt: Date;
}

export interface TemperatureLogDoc {
  id: string;
  tenantId: string;
  kitchenId?: string;
  kitchenNama?: string;
  stage: TempStage;
  suhuC: number;
  recordedAt: Date;
  tanggal: string;
  productionPlanId?: string;
  productionPlanNo?: string;
  productionBatchId?: string;
  batchNo?: string;
  qcResultId?: string;
  qcResultNo?: string;
  servicePointId?: string;
  servicePointNama?: string;
  thresholdMinC?: number;
  thresholdMaxC?: number;
  alertStatus: TempAlertStatus;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  acknowledgedByName?: string;
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export const TEMP_STAGE_LABELS: Record<TempStage, string> = {
  RECEIVING: 'Penerimaan (receiving)',
  COOKING: 'Memasak (cooking)',
  HOLDING: 'Holding (panas)',
};

export const TEMP_ALERT_LABELS: Record<TempAlertStatus, string> = {
  OK: 'OK',
  WARN: 'Peringatan',
  OUT_OF_RANGE: 'Di luar ambang',
  CRITICAL: 'Kritis',
};

/** Default food-safety bands (tenant may override via temperature_thresholds). */
export const DEFAULT_TEMP_THRESHOLDS: Record<TempStage, Required<Pick<TempThresholdBand, 'warnBandC' | 'criticalMarginC'>> & TempThresholdBand> = {
  RECEIVING: { minC: -2, maxC: 5, warnBandC: 1, criticalMarginC: 3 },
  COOKING: { minC: 74, maxC: 121, warnBandC: 2, criticalMarginC: 5 },
  HOLDING: { minC: 60, maxC: 95, warnBandC: 2, criticalMarginC: 5 },
};

export function normalizeTempStage(raw: unknown): TempStage | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (v === 'RECEIVING' || v === 'COOKING' || v === 'HOLDING') return v;
  return { error: 'stage wajib RECEIVING | COOKING | HOLDING' };
}

export function normalizeSuhuC(raw: unknown): number | { error: string } {
  if (raw == null || raw === '') return { error: 'suhuC wajib' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: 'suhuC harus angka' };
  if (n < -40 || n > 200) return { error: 'suhuC di luar rentang wajar (−40…200)' };
  return Math.round(n * 10) / 10;
}

export function normalizeAlertStatus(raw: unknown): TempAlertStatus | undefined {
  const v = String(raw || '').toUpperCase();
  if (v === 'OK' || v === 'WARN' || v === 'OUT_OF_RANGE' || v === 'CRITICAL') return v;
  return undefined;
}

export function resolveThresholdBand(
  stage: TempStage,
  override?: TempThresholdBand | null,
): TempThresholdBand {
  const base = DEFAULT_TEMP_THRESHOLDS[stage];
  if (!override) return { ...base };
  return {
    minC: override.minC !== undefined ? override.minC : base.minC,
    maxC: override.maxC !== undefined ? override.maxC : base.maxC,
    warnBandC: override.warnBandC !== undefined ? override.warnBandC : base.warnBandC,
    criticalMarginC: override.criticalMarginC !== undefined
      ? override.criticalMarginC
      : base.criticalMarginC,
  };
}

/**
 * Evaluate alert vs min/max band.
 * CRITICAL = beyond band by criticalMargin; OUT_OF_RANGE = outside band;
 * WARN = inside band but within warnBand of an edge; else OK.
 */
export function evaluateTempAlert(
  suhuC: number,
  band: TempThresholdBand,
): TempAlertStatus {
  const warnBand = band.warnBandC ?? 1;
  const critMargin = band.criticalMarginC ?? 3;
  const { minC, maxC } = band;

  if (minC != null && suhuC < minC) {
    return suhuC < minC - critMargin ? 'CRITICAL' : 'OUT_OF_RANGE';
  }
  if (maxC != null && suhuC > maxC) {
    return suhuC > maxC + critMargin ? 'CRITICAL' : 'OUT_OF_RANGE';
  }
  if (minC != null && suhuC <= minC + warnBand) return 'WARN';
  if (maxC != null && suhuC >= maxC - warnBand) return 'WARN';
  return 'OK';
}

export function isOpenTempAlert(status: TempAlertStatus): boolean {
  return status === 'WARN' || status === 'OUT_OF_RANGE' || status === 'CRITICAL';
}

/**
 * ADR-004 P0E — auto HOLD hanya untuk COOKING/HOLDING + OUT_OF_RANGE/CRITICAL
 * dengan productionBatchId. RECEIVING terkait GRN/lot, bukan batch.
 * WARN tidak menahan produk.
 */
export function shouldHoldBatchFromTemp(input: {
  stage: TempStage | string;
  alertStatus: TempAlertStatus | string;
  productionBatchId?: string | null;
}): boolean {
  const stage = String(input.stage || '').toUpperCase();
  const alert = String(input.alertStatus || '').toUpperCase();
  const batchId = String(input.productionBatchId || '').trim();
  if (!batchId) return false;
  if (stage !== 'COOKING' && stage !== 'HOLDING') return false;
  return alert === 'OUT_OF_RANGE' || alert === 'CRITICAL';
}

export function buildTempHoldReason(input: {
  stage: TempStage | string;
  alertStatus: TempAlertStatus | string;
  suhuC: number;
  minC?: number;
  maxC?: number;
  batchNo?: string;
}): string {
  const stageLabel = TEMP_STAGE_LABELS[String(input.stage).toUpperCase() as TempStage]
    || String(input.stage);
  const band = [
    input.minC != null ? String(input.minC) : '?',
    input.maxC != null ? String(input.maxC) : '?',
  ].join('–');
  const parts = [
    `Suhu ${stageLabel} ${input.suhuC}°C (${input.alertStatus})`,
    `ambang ${band}°C`,
  ];
  if (input.batchNo) parts.push(`batch ${input.batchNo}`);
  return parts.join(' · ');
}

export function normalizeThresholdNumbers(raw: {
  minC?: unknown;
  maxC?: unknown;
  warnBandC?: unknown;
  criticalMarginC?: unknown;
}): TempThresholdBand | { error: string } {
  const out: TempThresholdBand = {};
  for (const key of ['minC', 'maxC', 'warnBandC', 'criticalMarginC'] as const) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') continue;
    const n = Number(raw[key]);
    if (!Number.isFinite(n)) return { error: `${key} harus angka` };
    out[key] = Math.round(n * 10) / 10;
  }
  if (out.minC != null && out.maxC != null && out.minC > out.maxC) {
    return { error: 'minC tidak boleh lebih besar dari maxC' };
  }
  if (out.warnBandC != null && out.warnBandC < 0) return { error: 'warnBandC harus ≥ 0' };
  if (out.criticalMarginC != null && out.criticalMarginC < 0) {
    return { error: 'criticalMarginC harus ≥ 0' };
  }
  return out;
}
