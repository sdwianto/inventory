/**
 * Observation Engine — first-class aggregate (ADR-002).
 * May be Ignored / Resolved without becoming a Safety Case.
 */

import type { KaCategory } from '@/lib/kitchen-assurance/categories';
import type { KaDocHistoryEntry } from '@/lib/kitchen-assurance/document';
import type { KaSignalKind, KaSignalStatus } from '@/lib/kitchen-assurance/monitoring';
import type { KaPolicySeverity } from '@/lib/kitchen-assurance/policy';

export const KA_OBSERVATIONS_COLLECTION = 'ka_observations';

export type KaObservationStatus = 'OPEN' | 'IGNORED' | 'RESOLVED' | 'ESCALATED';

export const KA_OBSERVATION_TRANSITIONS: Record<KaObservationStatus, KaObservationStatus[]> = {
  OPEN: ['IGNORED', 'RESOLVED', 'ESCALATED'],
  IGNORED: [],
  RESOLVED: [],
  ESCALATED: [],
};

export interface KaObservationDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  category: KaCategory;
  capabilityId: string;
  policyId?: string;
  policyKode?: string;
  signalKind: KaSignalKind;
  signalKey: string;
  signalLabel: string;
  signalStatus: KaSignalStatus;
  severity?: KaPolicySeverity;
  value?: number | string | boolean;
  unit?: string;
  kitchenId?: string;
  kitchenNama?: string;
  sourceRef?: string;
  sourceCollection?: string;
  href?: string;
  status: KaObservationStatus;
  safetyCaseId?: string;
  safetyCaseNo?: string;
  catatan?: string;
  history: KaDocHistoryEntry[];
  observedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export const KA_OBSERVATION_STATUS_LABELS: Record<KaObservationStatus, string> = {
  OPEN: 'Terbuka',
  IGNORED: 'Diabaikan',
  RESOLVED: 'Selesai',
  ESCALATED: 'Dieskalasi',
};

export function normalizeObservationStatus(raw: unknown): KaObservationStatus | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (v === 'OPEN' || v === 'IGNORED' || v === 'RESOLVED' || v === 'ESCALATED') return v;
  return { error: 'status observation wajib OPEN | IGNORED | RESOLVED | ESCALATED' };
}
