/**
 * Follow Up — operational task linked to Issue (not CAPA) — ADR-002 P2.
 */

import type { KaCategory } from '@/lib/kitchen-assurance/categories';
import type { KaDocHistoryEntry } from '@/lib/kitchen-assurance/document';

export const KA_FOLLOW_UPS_COLLECTION = 'ka_follow_ups';

export type KaFollowUpStatus = 'OPEN' | 'DONE' | 'VERIFIED' | 'CANCELLED';
export type KaFollowUpPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Satu Issue hanya boleh punya satu FU aktif (OPEN/DONE) — cegah double entry. */
export const KA_ACTIVE_FOLLOW_UP_STATUSES: KaFollowUpStatus[] = ['OPEN', 'DONE'];

export const KA_FOLLOW_UP_TRANSITIONS: Record<KaFollowUpStatus, KaFollowUpStatus[]> = {
  OPEN: ['DONE', 'CANCELLED'],
  DONE: ['VERIFIED', 'OPEN', 'CANCELLED'],
  VERIFIED: [],
  CANCELLED: [],
};

export interface KaFollowUpDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  /** Wajib untuk FU baru — Issue sumber (legacy boleh kosong). */
  safetyCaseId?: string;
  safetyCaseNo?: string;
  observationId?: string;
  observationNo?: string;
  /** Pillar lens — copied from case when linked */
  category?: KaCategory;
  kitchenId?: string;
  kitchenNama?: string;
  title: string;
  description?: string;
  ownerUserId?: string;
  ownerName?: string;
  priority: KaFollowUpPriority;
  dueAt?: Date | string;
  evidenceMedia: string[];
  /** Komentar / keterangan saat upload evidence */
  evidenceNote?: string;
  status: KaFollowUpStatus;
  verifiedAt?: Date;
  verifiedBy?: string;
  verifiedByName?: string;
  history: KaDocHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export const KA_FOLLOW_UP_STATUS_LABELS: Record<KaFollowUpStatus, string> = {
  OPEN: 'Terbuka',
  DONE: 'Selesai dikerjakan',
  VERIFIED: 'Terverifikasi',
  CANCELLED: 'Dibatalkan',
};

export const KA_FOLLOW_UP_PRIORITY_LABELS: Record<KaFollowUpPriority, string> = {
  LOW: 'Rendah',
  MEDIUM: 'Sedang',
  HIGH: 'Tinggi',
  CRITICAL: 'Kritis',
};

export function normalizeFollowUpStatus(raw: unknown): KaFollowUpStatus | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (v === 'OPEN' || v === 'DONE' || v === 'VERIFIED' || v === 'CANCELLED') return v;
  return { error: 'status follow-up wajib OPEN | DONE | VERIFIED | CANCELLED' };
}

export function normalizeFollowUpPriority(raw: unknown): KaFollowUpPriority {
  const v = String(raw || 'MEDIUM').toUpperCase();
  if (v === 'LOW' || v === 'MEDIUM' || v === 'HIGH' || v === 'CRITICAL') return v;
  return 'MEDIUM';
}

/** Evidence required before VERIFIED. */
export function assertFollowUpCanVerify(doc: Pick<KaFollowUpDoc, 'evidenceMedia' | 'status'>): string | null {
  if (doc.status !== 'DONE') return 'Hanya status DONE yang bisa diverifikasi';
  if (!doc.evidenceMedia?.length) return 'Evidence wajib sebelum verifikasi';
  return null;
}

export function activeFollowUpConflictMessage(existingNo?: string): string {
  const ref = existingNo ? ` (${existingNo})` : '';
  return `Issue ini sudah punya follow-up aktif${ref}. Selesaikan & verifikasi dulu, atau batalkan follow-up yang ada.`;
}
