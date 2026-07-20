/**
 * Monitoring Engine — evaluates adapter signals against Policy (ADR-002).
 * Signal kinds: MEASUREMENT | CHECKLIST | EVENT.
 */

import type { KaCategory } from '@/lib/kitchen-assurance/categories';
import type { KaPolicyDoc, KaPolicyRules, KaPolicySeverity } from '@/lib/kitchen-assurance/policy';

export const KA_MONITORING_DEFINITIONS_COLLECTION = 'ka_monitoring_definitions';

export type KaSignalKind = 'MEASUREMENT' | 'CHECKLIST' | 'EVENT';
export type KaSignalStatus = 'OK' | 'WATCH' | 'BREACH';

export interface KitchenScope {
  tenantId: string;
  kitchenId?: string;
}

export interface MonitoringSignal {
  capabilityId: string;
  category: KaCategory;
  kind: KaSignalKind;
  key: string;
  label: string;
  status: KaSignalStatus;
  value?: number | string | boolean;
  unit?: string;
  recordedAt?: string | Date;
  href?: string;
  sourceRef?: string;
  sourceCollection?: string;
  kitchenId?: string;
  kitchenNama?: string;
  severity?: KaPolicySeverity;
  meta?: Record<string, unknown>;
}

export type MonitoringAdapter = {
  capabilityId: string;
  listSignals(
    scope: KitchenScope,
    policies: KaPolicyDoc[],
  ): Promise<MonitoringSignal[]>;
};

export interface KaMonitoringDefinitionDoc {
  id: string;
  tenantId: string;
  capabilityId: string;
  category: KaCategory;
  kode: string;
  nama: string;
  signalKind: KaSignalKind;
  aktif: boolean;
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Seed definitions for Phase 0 capabilities (KA-owned templates). */
export const DEFAULT_KA_MONITORING_DEFINITIONS: Array<
  Omit<KaMonitoringDefinitionDoc, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>
> = [
  {
    capabilityId: 'cold-chain',
    category: 'FOOD',
    kode: 'DEF-CC',
    nama: 'Cold Chain temperature measurement',
    signalKind: 'MEASUREMENT',
    aktif: true,
  },
  {
    capabilityId: 'cleaning',
    category: 'OPERATION',
    kode: 'DEF-CLEAN',
    nama: 'Cleaning checklist / schedule',
    signalKind: 'CHECKLIST',
    aktif: true,
  },
  {
    capabilityId: 'equipment-inspection',
    category: 'EQUIPMENT',
    kode: 'DEF-EQ-INSP',
    nama: 'Equipment inspection overdue event',
    signalKind: 'EVENT',
    aktif: true,
  },
  {
    capabilityId: 'quality-complaint',
    category: 'FOOD',
    kode: 'DEF-QCMPL',
    nama: 'Food complaint / recall event (Quality stub)',
    signalKind: 'EVENT',
    aktif: true,
  },
];

export function normalizeSignalKind(raw: unknown): KaSignalKind | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (v === 'MEASUREMENT' || v === 'CHECKLIST' || v === 'EVENT') return v;
  return { error: 'signalKind wajib MEASUREMENT | CHECKLIST | EVENT' };
}

/** Map owner alert → KA signal status. */
export function mapAlertToSignalStatus(alert: string | undefined): KaSignalStatus {
  const a = String(alert || 'OK').toUpperCase();
  if (a === 'OK') return 'OK';
  if (a === 'WARN') return 'WATCH';
  if (a === 'OUT_OF_RANGE' || a === 'CRITICAL' || a === 'BREACH') return 'BREACH';
  return 'WATCH';
}

export function evaluateNumericAgainstPolicy(
  value: number,
  rules: KaPolicyRules,
): KaSignalStatus {
  const { minValue, maxValue } = rules;
  if (minValue != null && value < minValue) return 'BREACH';
  if (maxValue != null && value > maxValue) return 'BREACH';
  if (minValue != null && maxValue != null) {
    const span = maxValue - minValue;
    const warnBand = span * 0.1;
    if (value <= minValue + warnBand || value >= maxValue - warnBand) return 'WATCH';
  }
  return 'OK';
}

export const KA_SIGNAL_STATUS_LABELS: Record<KaSignalStatus, string> = {
  OK: 'OK',
  WATCH: 'Perlu perhatian',
  BREACH: 'Pelanggaran',
};

export const KA_SIGNAL_KIND_LABELS: Record<KaSignalKind, string> = {
  MEASUREMENT: 'Pengukuran',
  CHECKLIST: 'Checklist',
  EVENT: 'Event',
};
