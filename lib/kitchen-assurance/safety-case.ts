/**
 * Issue / Case aggregate — ADR-002 P2.
 * Flow: Issue → Follow Up (optional) → Closed.
 * Resolution Engine frozen (legacy field only).
 */

import type { KaCategory } from '@/lib/kitchen-assurance/categories';
import type { KaDocHistoryEntry } from '@/lib/kitchen-assurance/document';
import type { KaPolicySeverity } from '@/lib/kitchen-assurance/policy';

export const KA_SAFETY_CASES_COLLECTION = 'ka_safety_cases';

export type KaCaseKind =
  | 'INCIDENT'
  | 'NEAR_MISS'
  | 'NONCONFORMANCE'
  | 'RISK'
  | 'COMPLAINT'
  | 'BREACH'
  | 'OTHER';

export type KaCaseStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'PENDING_VERIFY'
  | 'CLOSED'
  | 'CANCELLED';

/** How the case is resolved — Follow Up only when needed. */
export type KaResolutionType =
  | 'NONE'
  | 'CLOSE_ONLY'
  | 'FOLLOW_UP'
  | 'LINK_WR'
  | 'HOLD_BATCH'
  | 'DISCARD_BATCH'
  | 'REPLACE_ASSET';

/** P2 flow: Issue → (FU) → Closed. PENDING_VERIFY kept for legacy open docs. */
export const KA_CASE_TRANSITIONS: Record<KaCaseStatus, KaCaseStatus[]> = {
  OPEN: ['IN_PROGRESS', 'CLOSED', 'CANCELLED'],
  IN_PROGRESS: ['CLOSED', 'OPEN', 'CANCELLED', 'PENDING_VERIFY'],
  PENDING_VERIFY: ['CLOSED', 'IN_PROGRESS', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

export interface KaCaseResolution {
  type: KaResolutionType;
  summary?: string;
  followUpId?: string;
  followUpNo?: string;
  maintenanceRequestId?: string;
  inventoryHoldRef?: string;
  resolvedAt?: Date | string;
  resolvedBy?: string;
  resolvedByName?: string;
}

export interface KaSafetyCaseDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  category: KaCategory;
  caseKind: KaCaseKind;
  title: string;
  description?: string;
  severity?: KaPolicySeverity;
  status: KaCaseStatus;
  observationId?: string;
  observationNo?: string;
  capabilityId?: string;
  policyId?: string;
  /** Idempotency key for automation / Monitoring → Issue (P3) */
  sourceKey?: string;
  sourceHref?: string;
  kitchenId?: string;
  kitchenNama?: string;
  batchId?: string;
  planId?: string;
  assetId?: string;
  maintenanceRequestId?: string;
  productId?: string;
  inventoryHoldRef?: string;
  resolution?: KaCaseResolution;
  /** Foto bukti Issue (maks 3) */
  photos?: string[];
  /** Waktu kejadian / log (hari-tanggal-jam) */
  loggedAt?: Date | string;
  history: KaDocHistoryEntry[];
  tanggal: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export const KA_CASE_KIND_LABELS: Record<KaCaseKind, string> = {
  INCIDENT: 'Insiden',
  NEAR_MISS: 'Near miss',
  NONCONFORMANCE: 'Ketidaksesuaian',
  RISK: 'Risiko',
  COMPLAINT: 'Keluhan',
  BREACH: 'Pelanggaran',
  OTHER: 'Lainnya',
};

export const KA_CASE_STATUS_LABELS: Record<KaCaseStatus, string> = {
  OPEN: 'Terbuka',
  IN_PROGRESS: 'Diproses',
  PENDING_VERIFY: 'Menunggu verifikasi',
  CLOSED: 'Ditutup',
  CANCELLED: 'Dibatalkan',
};

export const KA_RESOLUTION_LABELS: Record<KaResolutionType, string> = {
  NONE: 'Belum ada',
  CLOSE_ONLY: 'Tutup saja',
  FOLLOW_UP: 'Perlu follow-up',
  LINK_WR: 'Link Work Request',
  HOLD_BATCH: 'Tahan batch',
  DISCARD_BATCH: 'Buang batch',
  REPLACE_ASSET: 'Ganti aset',
};

export function normalizeCaseKind(raw: unknown): KaCaseKind | { error: string } {
  const v = String(raw || '').toUpperCase();
  const allowed = Object.keys(KA_CASE_KIND_LABELS);
  if (allowed.includes(v)) return v as KaCaseKind;
  return { error: `caseKind wajib ${allowed.join(' | ')}` };
}

export function normalizeCaseStatus(raw: unknown): KaCaseStatus | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (
    v === 'OPEN' ||
    v === 'IN_PROGRESS' ||
    v === 'PENDING_VERIFY' ||
    v === 'CLOSED' ||
    v === 'CANCELLED'
  ) {
    return v;
  }
  return { error: 'status case wajib OPEN | IN_PROGRESS | PENDING_VERIFY | CLOSED | CANCELLED' };
}

/**
 * Block terminal case transitions (CLOSED | CANCELLED) while active follow-ups remain.
 * Active FU count is typically OPEN | DONE (see KA_ACTIVE_FOLLOW_UP_STATUSES).
 * Returns Indonesian soft-gate message, or null when allowed.
 */
export function assertKaCaseTerminalBlockedByActiveFollowUps(
  toStatus: string,
  activeFollowUpCount: number,
): string | null {
  if (activeFollowUpCount <= 0) return null;
  if (toStatus === 'CLOSED') {
    return `Tidak bisa tutup: masih ada ${activeFollowUpCount} follow-up aktif/belum diverifikasi`;
  }
  if (toStatus === 'CANCELLED') {
    return `Tidak bisa batalkan: masih ada ${activeFollowUpCount} follow-up aktif/belum diverifikasi`;
  }
  return null;
}

export function normalizeResolutionType(raw: unknown): KaResolutionType | { error: string } {
  const v = String(raw || '').toUpperCase();
  const allowed = Object.keys(KA_RESOLUTION_LABELS);
  if (allowed.includes(v)) return v as KaResolutionType;
  return { error: `resolution.type wajib ${allowed.join(' | ')}` };
}

/**
 * W2-29 — dotted $set stamp for resolution follow-up pointer.
 * Never replaces the whole `resolution` object; never touches `resolution.type`.
 */
export function buildKaResolutionFollowUpStamp(fu: {
  id: string;
  noDokumen?: string;
}): Record<string, unknown> {
  return {
    'resolution.followUpId': fu.id,
    'resolution.followUpNo': fu.noDokumen || undefined,
  };
}
