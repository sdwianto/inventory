/**
 * HACCP system verification — ADR-004 Fase 5.
 * Record ringan (bukan engine), terpisah dari KA follow-up VERIFIED.
 * Mencakup verifikasi periodik plan dan kelengkapan record monitoring.
 */

import { appendDocHistory, type DocHistoryEntry } from '@/lib/food-production/document';

export const HACCP_VERIFICATIONS_COLLECTION = 'haccp_verifications';

export type HaccpVerificationType =
  | 'PLAN'
  | 'RECORD_COMPLETENESS'
  | 'CCP_MONITORING'
  | 'VALIDATION';

export type HaccpVerificationResult = 'PASS' | 'FAIL' | 'PARTIAL';

export type HaccpVerificationStatus = 'DRAFT' | 'COMPLETED' | 'CANCELLED';

export interface HaccpVerificationDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  verificationType: HaccpVerificationType;
  /** Tanggal verifikasi (YYYY-MM-DD). */
  tanggal: string;
  method: string;
  result: HaccpVerificationResult;
  status: HaccpVerificationStatus;
  /** Wajib untuk type PLAN. */
  haccpPlanId?: string;
  haccpPlanKode?: string;
  /** Wajib untuk RECORD_COMPLETENESS / CCP_MONITORING. */
  haccpResultId?: string;
  haccpResultNo?: string;
  productionBatchId?: string;
  kitchenId?: string;
  note?: string;
  evidenceUrls?: string[];
  verifiedBy: string;
  verifiedByName?: string;
  verifiedAt: Date;
  history: DocHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export const HACCP_VERIFICATION_TYPE_LABELS: Record<HaccpVerificationType, string> = {
  PLAN: 'Verifikasi plan HACCP',
  RECORD_COMPLETENESS: 'Kelengkapan record monitoring',
  CCP_MONITORING: 'Verifikasi monitoring CCP',
  VALIDATION: 'Validasi rencana HACCP',
};

export const HACCP_VERIFICATION_RESULT_LABELS: Record<HaccpVerificationResult, string> = {
  PASS: 'Lolos',
  FAIL: 'Gagal',
  PARTIAL: 'Sebagian',
};

export const HACCP_VERIFICATION_TRANSITIONS: Record<
  HaccpVerificationStatus,
  HaccpVerificationStatus[]
> = {
  DRAFT: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function normalizeHaccpVerificationType(
  raw: unknown,
): HaccpVerificationType | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (v === 'PLAN' || v === 'RECORD_COMPLETENESS' || v === 'CCP_MONITORING' || v === 'VALIDATION') return v;
  return { error: 'verificationType wajib PLAN|RECORD_COMPLETENESS|CCP_MONITORING|VALIDATION' };
}

export function normalizeHaccpVerificationResult(
  raw: unknown,
): HaccpVerificationResult | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (v === 'PASS' || v === 'FAIL' || v === 'PARTIAL') return v;
  return { error: 'result wajib PASS|FAIL|PARTIAL' };
}

export function normalizeHaccpVerificationStatus(
  raw: unknown,
): HaccpVerificationStatus | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (v === 'DRAFT' || v === 'COMPLETED' || v === 'CANCELLED') return v;
  return { error: 'status wajib DRAFT|COMPLETED|CANCELLED' };
}

/**
 * Gate konten sebelum COMPLETED.
 * - PLAN / VALIDATION → haccpPlanId wajib
 * - RECORD_* / CCP_MONITORING → haccpResultId wajib
 * - method wajib
 * - PASS → minimal satu evidence (jejak audit)
 */
export function assertHaccpVerificationReady(doc: Pick<
  HaccpVerificationDoc,
  | 'verificationType'
  | 'method'
  | 'result'
  | 'haccpPlanId'
  | 'haccpResultId'
  | 'evidenceUrls'
>): string | null {
  if (!String(doc.method || '').trim()) return 'method wajib';
  if (doc.verificationType === 'PLAN' || doc.verificationType === 'VALIDATION') {
    if (!String(doc.haccpPlanId || '').trim()) {
      return `haccpPlanId wajib untuk verificationType ${doc.verificationType}`;
    }
  } else if (!String(doc.haccpResultId || '').trim()) {
    return 'haccpResultId wajib untuk verifikasi record/CCP';
  }
  if (doc.result === 'PASS' && !(doc.evidenceUrls || []).length) {
    return 'Evidence wajib sebelum COMPLETED dengan result PASS';
  }
  return null;
}

export function appendHaccpVerificationHistory(
  history: DocHistoryEntry[] | undefined,
  entry: DocHistoryEntry,
): DocHistoryEntry[] {
  return appendDocHistory(history, entry);
}
