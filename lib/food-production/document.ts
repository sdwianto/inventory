/**
 * Thin document helpers for Food Production (ADR-001 Phase 0).
 * Pure / client-safe — no Mongo or document-sequence imports.
 */

export const FP_DOC_TYPES = {
  PRODUCTION_PLAN: 'FP_PLAN',
  MATERIAL_REQUIREMENT: 'FP_MRP',
  PURCHASE_REQUIREMENT: 'FP_PR',
  MATERIAL_ISSUE: 'FP_ISSUE',
  PRODUCTION_RESULT: 'FP_RESULT',
  QC_RESULT: 'FP_QC',
  KITCHEN_TRANSFER: 'FP_XFER',
  DISTRIBUTION_ORDER: 'FP_DIST',
  HACCP_RESULT: 'FP_HACCP',
  HACCP_PLAN: 'FP_HPLAN',
  HACCP_VERIFICATION: 'FP_HVER',
} as const;

export type FpDocType = (typeof FP_DOC_TYPES)[keyof typeof FP_DOC_TYPES];

export const FP_DOC_PREFIX: Record<FpDocType, string> = {
  FP_PLAN: 'RPN',
  FP_MRP: 'KBH',
  FP_PR: 'PRB',
  FP_ISSUE: 'PBL',
  FP_RESULT: 'HSL',
  FP_QC: 'QCR',
  FP_XFER: 'XFR',
  FP_DIST: 'DST',
  FP_HACCP: 'HCP',
  FP_HPLAN: 'HPL',
  FP_HVER: 'HVR',
};

/** Generic lifecycle used by Plan / Issue / Result until a richer engine exists. */
export type FpDocStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'CANCELLED';

/** Statuses that count as "open" for unique partial indexes (one active doc per plan/MRP). */
export const FP_OPEN_DOC_STATUSES: readonly FpDocStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'PROCESSING',
];

export const FP_DEFAULT_TRANSITIONS: Record<FpDocStatus, FpDocStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export interface DocHistoryEntry {
  at: Date | string;
  fromStatus: string | null;
  toStatus: string;
  userId?: string;
  userName?: string;
  note?: string;
}

export function assertStatusTransition(
  from: string,
  to: string,
  allowed: Record<string, string[]> = FP_DEFAULT_TRANSITIONS,
): string | null {
  if (from === to) return null;
  const next = allowed[from];
  if (!next || !next.includes(to)) {
    return `Status tidak boleh dari ${from} ke ${to}`;
  }
  return null;
}

/** Generic so callers with a richer entry (mis. FoodSafetyHistoryEntry) keep their type. */
export function appendDocHistory<T extends DocHistoryEntry>(
  history: T[] | null | undefined,
  entry: T,
): T[] {
  return [...(history || []), entry];
}
