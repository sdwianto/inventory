/**
 * Policy Engine — SOP, threshold, frequency, severity (ADR-002).
 * Policies bind a capability to evaluation rules; adapters supply raw signals.
 */

import type { KaCategory } from '@/lib/kitchen-assurance/categories';

export const KA_POLICIES_COLLECTION = 'ka_policies';

export type KaPolicySeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type KaPolicyKind =
  | 'THRESHOLD'
  | 'FREQUENCY'
  | 'MANDATORY'
  | 'EVENT_TRIGGER';

export type KaBreachAction = 'OBSERVE' | 'SUGGEST_CASE' | 'AUTO_CASE' | 'LINK_WR';

export interface KaPolicyRules {
  /** Temperature / numeric bounds */
  minValue?: number;
  maxValue?: number;
  unit?: string;
  /** Minutes outside band before BREACH */
  breachAfterMinutes?: number;
  /** Frequency: every N hours / per shift */
  everyHours?: number;
  allowLateMinutes?: number;
  perShift?: boolean;
  /** Checklist / mandatory keys */
  requiredItems?: string[];
  /** Event matching */
  eventTypes?: string[];
  /** Escalation */
  severity?: KaPolicySeverity;
  onBreach?: KaBreachAction;
  autoEscalate?: boolean;
}

export interface KaPolicyDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  kode: string;
  nama: string;
  capabilityId: string;
  category: KaCategory;
  kind: KaPolicyKind;
  rules: KaPolicyRules;
  aktif: boolean;
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export const KA_POLICY_KIND_LABELS: Record<KaPolicyKind, string> = {
  THRESHOLD: 'Ambang nilai',
  FREQUENCY: 'Frekuensi',
  MANDATORY: 'Wajib',
  EVENT_TRIGGER: 'Pemicu event',
};

export const KA_SEVERITY_LABELS: Record<KaPolicySeverity, string> = {
  LOW: 'Rendah',
  MEDIUM: 'Sedang',
  HIGH: 'Tinggi',
  CRITICAL: 'Kritis',
};

/** Seed policies for Phase 0 (tenant-scoped on first ensure). */
export const DEFAULT_KA_POLICIES: Array<
  Omit<KaPolicyDoc, 'id' | 'tenantId' | 'noDokumen' | 'createdAt' | 'updatedAt'>
> = [
  {
    kode: 'POL-CC-HOLD',
    nama: 'Cold Chain Holding ≤ 5°C warn / out-of-range escalate',
    capabilityId: 'cold-chain',
    category: 'FOOD',
    kind: 'THRESHOLD',
    rules: {
      maxValue: 5,
      unit: 'C',
      breachAfterMinutes: 15,
      severity: 'HIGH',
      onBreach: 'SUGGEST_CASE',
      autoEscalate: false,
    },
    aktif: true,
  },
  {
    kode: 'POL-CLEAN-4H',
    nama: 'Cleaning setiap 4 jam',
    capabilityId: 'cleaning',
    category: 'OPERATION',
    kind: 'FREQUENCY',
    rules: {
      everyHours: 4,
      allowLateMinutes: 15,
      severity: 'MEDIUM',
      onBreach: 'OBSERVE',
      autoEscalate: false,
    },
    aktif: true,
  },
  {
    kode: 'POL-EQ-INSP',
    nama: 'Equipment inspection overdue → WR',
    capabilityId: 'equipment-inspection',
    category: 'EQUIPMENT',
    kind: 'EVENT_TRIGGER',
    rules: {
      eventTypes: ['INSPECTION_OVERDUE'],
      severity: 'HIGH',
      onBreach: 'LINK_WR',
      autoEscalate: false,
    },
    aktif: true,
  },
  {
    kode: 'POL-QCMPL',
    nama: 'Food complaint / recall event',
    capabilityId: 'quality-complaint',
    category: 'FOOD',
    kind: 'EVENT_TRIGGER',
    rules: {
      eventTypes: ['COMPLAINT', 'RECALL'],
      severity: 'HIGH',
      onBreach: 'SUGGEST_CASE',
      autoEscalate: false,
    },
    aktif: true,
  },
];

export function normalizePolicyKind(raw: unknown): KaPolicyKind | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (v === 'THRESHOLD' || v === 'FREQUENCY' || v === 'MANDATORY' || v === 'EVENT_TRIGGER') {
    return v;
  }
  return { error: 'kind wajib THRESHOLD | FREQUENCY | MANDATORY | EVENT_TRIGGER' };
}

export function normalizePolicyRules(raw: unknown): KaPolicyRules {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const rules: KaPolicyRules = {};
  if (o.minValue != null && Number.isFinite(Number(o.minValue))) rules.minValue = Number(o.minValue);
  if (o.maxValue != null && Number.isFinite(Number(o.maxValue))) rules.maxValue = Number(o.maxValue);
  if (o.unit != null) rules.unit = String(o.unit);
  if (o.breachAfterMinutes != null && Number.isFinite(Number(o.breachAfterMinutes))) {
    rules.breachAfterMinutes = Number(o.breachAfterMinutes);
  }
  if (o.everyHours != null && Number.isFinite(Number(o.everyHours))) {
    rules.everyHours = Number(o.everyHours);
  }
  if (o.allowLateMinutes != null && Number.isFinite(Number(o.allowLateMinutes))) {
    rules.allowLateMinutes = Number(o.allowLateMinutes);
  }
  if (o.perShift != null) rules.perShift = Boolean(o.perShift);
  if (Array.isArray(o.requiredItems)) {
    rules.requiredItems = o.requiredItems.map((x) => String(x)).filter(Boolean);
  }
  if (Array.isArray(o.eventTypes)) {
    rules.eventTypes = o.eventTypes.map((x) => String(x)).filter(Boolean);
  }
  const sev = String(o.severity || '').toUpperCase();
  if (sev === 'LOW' || sev === 'MEDIUM' || sev === 'HIGH' || sev === 'CRITICAL') {
    rules.severity = sev;
  }
  const ob = String(o.onBreach || '').toUpperCase();
  if (ob === 'OBSERVE' || ob === 'SUGGEST_CASE' || ob === 'AUTO_CASE' || ob === 'LINK_WR') {
    rules.onBreach = ob;
  }
  if (o.autoEscalate != null) rules.autoEscalate = Boolean(o.autoEscalate);
  return rules;
}
