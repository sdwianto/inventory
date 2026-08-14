/**
 * HACCP Study Plan — ADR-004 Fase 3.
 * Container hazard analysis + CCP + critical limit terstruktur + monitoring plan.
 * Embedded arrays (bukan collection terpisah). Template checklist tetap di haccp_templates.
 *
 * Konten contoh / seed berlabel contoh — batas resmi ditetapkan pihak berkompeten.
 */

import { appendDocHistory, type DocHistoryEntry } from '@/lib/food-production/document';
import type { HaccpCategory } from '@/lib/food-production/haccp';

export const HACCP_PLANS_COLLECTION = 'haccp_plans';

/** Lifecycle study — terpisah dari status checklist haccp_results. */
export type HaccpPlanStatus =
  | 'DRAFT'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'ACTIVE'
  | 'SUPERSEDED'
  | 'CANCELLED';

export type HaccpHazardType = 'BIOLOGICAL' | 'CHEMICAL' | 'PHYSICAL';

export type CriticalLimitOperator =
  | 'GTE'
  | 'GT'
  | 'LTE'
  | 'LT'
  | 'EQ'
  | 'BETWEEN'
  | 'TEXT';

export interface HaccpProcessStep {
  key: string;
  nama: string;
  sequence: number;
  description?: string;
}

export interface HaccpHazard {
  key: string;
  processStepKey: string;
  hazardType: HaccpHazardType;
  description: string;
  /** Apakah hazard ini menjadi CCP. */
  isCcp: boolean;
  /**
   * Alasan keputusan CCP (scope §12) — wajib bila isCcp=true.
   */
  ccpJustification?: string;
  controlMeasure?: string;
  significance?: string;
}

export interface HaccpCcp {
  key: string;
  processStepKey: string;
  hazardKeys: string[];
  nama: string;
  /** Kategori operasional existing (CCP_COOK, …) bila relevan. */
  category?: HaccpCategory;
  monitoringMethod?: string;
  correctiveAction?: string;
}

/**
 * Critical limit terstruktur — menggantikan criticalLimitNote string bebas.
 */
export interface HaccpCriticalLimit {
  key: string;
  ccpKey?: string;
  processStepKey?: string;
  parameter: string;
  label: string;
  operator: CriticalLimitOperator;
  value?: number;
  valueMax?: number;
  unit?: string;
  durationMinutes?: number;
  /** Teks bebas bila operator TEXT atau catatan tambahan. */
  note?: string;
}

export interface HaccpMonitoringPlan {
  key: string;
  ccpKey: string;
  method: string;
  frequency: string;
  responsibleRole?: string;
  criticalLimitKeys: string[];
  /** Hint ke kode template checklist existing (haccp_templates.kode). */
  templateKodeHint?: string;
}

/** Anggota Tim HACCP (BGN 8.1.1) — lean, bukan HR master. */
export interface HaccpTeamMember {
  name: string;
  role: string;
  unit?: string;
}

export interface HaccpPlanDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  kode: string;
  nama: string;
  description?: string;
  version: number;
  effectiveDate?: string;
  supersededById?: string;
  status: HaccpPlanStatus;
  recipeIds: string[];
  menuIds: string[];
  /** BGN 8.1 — tim multidisiplin. */
  team: HaccpTeamMember[];
  /** BGN 8.1.2 — ruang lingkup studi. */
  scope?: string;
  /** BGN 8.2 — deskripsi produk (teks; recipe/menu sebagai tautan). */
  productDescription?: string;
  /** BGN 8.3 — tujuan penggunaan & pengguna. */
  intendedUse?: string;
  /** BGN 8.4 — catatan / keterangan diagram alir. */
  flowDiagramNote?: string;
  /** BGN 8.4 — foto/sketsa alur (URL media). */
  flowDiagramUrls?: string[];
  /** BGN 8.5 — konfirmasi diagram di lapangan. */
  flowVerifiedAt?: Date;
  flowVerifiedBy?: string;
  flowVerifiedByName?: string;
  flowVerifiedNote?: string;
  /** BGN 8.11 — validasi rencana (bukti + catatan). */
  validationNote?: string;
  validationEvidenceUrls?: string[];
  validatedAt?: Date;
  validatedBy?: string;
  validatedByName?: string;
  /** BGN 8.13 — bukti pelatihan lean (bukan HR). */
  trainingNote?: string;
  trainingEvidenceUrls?: string[];
  processSteps: HaccpProcessStep[];
  hazards: HaccpHazard[];
  ccps: HaccpCcp[];
  criticalLimits: HaccpCriticalLimit[];
  monitoringPlans: HaccpMonitoringPlan[];
  /** Label contoh — bukan acuan hukum. */
  isExample?: boolean;
  history: DocHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
  approvedAt?: Date;
  approvedBy?: string;
  approvedByName?: string;
  activatedAt?: Date;
  activatedBy?: string;
  activatedByName?: string;
}

export const HACCP_PLAN_STATUS_LABELS: Record<HaccpPlanStatus, string> = {
  DRAFT: 'Draft',
  UNDER_REVIEW: 'Dalam review',
  APPROVED: 'Disetujui',
  ACTIVE: 'Aktif',
  SUPERSEDED: 'Digantikan',
  CANCELLED: 'Dibatalkan',
};

export const HACCP_PLAN_TRANSITIONS: Record<HaccpPlanStatus, HaccpPlanStatus[]> = {
  DRAFT: ['UNDER_REVIEW', 'CANCELLED'],
  UNDER_REVIEW: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['SUPERSEDED', 'CANCELLED'],
  SUPERSEDED: [],
  CANCELLED: [],
};

/** Studi A–D hanya draft/review. */
export function haccpPlanAllowsStudyEdit(status: HaccpPlanStatus): boolean {
  return status === 'DRAFT' || status === 'UNDER_REVIEW';
}

/** Gelombang E — validasi & pelatihan boleh diisi setelah rencana disetujui/aktif. */
export function haccpPlanAllowsCloseoutEdit(status: HaccpPlanStatus): boolean {
  return haccpPlanAllowsStudyEdit(status) || status === 'APPROVED' || status === 'ACTIVE';
}

export function hasHaccpPlanValidation(plan?: {
  validatedAt?: Date | string | null;
  validationNote?: string | null;
  validationEvidenceUrls?: string[] | null;
} | null): boolean {
  if (!plan) return false;
  return Boolean(
    plan.validatedAt
    || String(plan.validationNote || '').trim()
    || (plan.validationEvidenceUrls || []).length,
  );
}

export function hasHaccpTrainingEvidence(plan?: {
  trainingNote?: string | null;
  trainingEvidenceUrls?: string[] | null;
} | null): boolean {
  if (!plan) return false;
  return Boolean(String(plan.trainingNote || '').trim() || (plan.trainingEvidenceUrls || []).length);
}

export const HACCP_HAZARD_TYPE_LABELS: Record<HaccpHazardType, string> = {
  BIOLOGICAL: 'Biologis',
  CHEMICAL: 'Kimia',
  PHYSICAL: 'Fisik',
};

export const CRITICAL_LIMIT_OPERATOR_LABELS: Record<CriticalLimitOperator, string> = {
  GTE: '≥',
  GT: '>',
  LTE: '≤',
  LT: '<',
  EQ: '=',
  BETWEEN: 'antara',
  TEXT: 'teks',
};

export function normalizeHaccpPlanStatus(
  raw: unknown,
): HaccpPlanStatus | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (
    v === 'DRAFT'
    || v === 'UNDER_REVIEW'
    || v === 'APPROVED'
    || v === 'ACTIVE'
    || v === 'SUPERSEDED'
    || v === 'CANCELLED'
  ) {
    return v;
  }
  return {
    error: 'status wajib DRAFT|UNDER_REVIEW|APPROVED|ACTIVE|SUPERSEDED|CANCELLED',
  };
}

export function normalizeHazardType(raw: unknown): HaccpHazardType | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (v === 'BIOLOGICAL' || v === 'CHEMICAL' || v === 'PHYSICAL') return v;
  return { error: 'hazardType wajib BIOLOGICAL|CHEMICAL|PHYSICAL' };
}

export function normalizeCriticalLimitOperator(
  raw: unknown,
): CriticalLimitOperator | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (
    v === 'GTE' || v === 'GT' || v === 'LTE' || v === 'LT'
    || v === 'EQ' || v === 'BETWEEN' || v === 'TEXT'
  ) {
    return v;
  }
  return { error: 'operator wajib GTE|GT|LTE|LT|EQ|BETWEEN|TEXT' };
}

function slugKey(raw: string, fallback: string): string {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return s || fallback;
}

export function normalizeProcessSteps(raw: unknown): HaccpProcessStep[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: 'processSteps wajib array' };
  const out: HaccpProcessStep[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const key = slugKey(String(row.key || ''), `step_${i + 1}`);
    const nama = String(row.nama || row.name || '').trim();
    if (!nama) return { error: `processSteps[${i}]: nama wajib` };
    if (seen.has(key)) return { error: `processSteps duplikat: ${key}` };
    seen.add(key);
    out.push({
      key,
      nama,
      sequence: Number(row.sequence) > 0 ? Number(row.sequence) : i + 1,
      description: String(row.description || '').trim() || undefined,
    });
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

export function normalizeHazards(
  raw: unknown,
  stepKeys: Set<string>,
): HaccpHazard[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: 'hazards wajib array' };
  const out: HaccpHazard[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const key = slugKey(String(row.key || ''), `hz_${i + 1}`);
    const processStepKey = String(row.processStepKey || '').trim();
    if (!processStepKey) return { error: `hazards[${i}]: processStepKey wajib` };
    if (stepKeys.size && !stepKeys.has(processStepKey)) {
      return { error: `hazards[${i}]: processStepKey "${processStepKey}" tidak ada di processSteps` };
    }
    const hazardType = normalizeHazardType(row.hazardType);
    if (typeof hazardType !== 'string') return { error: `hazards[${i}]: ${hazardType.error}` };
    const description = String(row.description || '').trim();
    if (!description) return { error: `hazards[${i}]: description wajib` };
    const isCcp = row.isCcp === true;
    const ccpJustification = String(row.ccpJustification || '').trim() || undefined;
    if (isCcp && !ccpJustification) {
      return { error: `hazards[${i}]: ccpJustification wajib bila isCcp=true` };
    }
    if (seen.has(key)) return { error: `hazards duplikat: ${key}` };
    seen.add(key);
    out.push({
      key,
      processStepKey,
      hazardType,
      description,
      isCcp,
      ccpJustification,
      controlMeasure: String(row.controlMeasure || '').trim() || undefined,
      significance: String(row.significance || '').trim() || undefined,
    });
  }
  return out;
}

export function normalizeCcps(
  raw: unknown,
  stepKeys: Set<string>,
  hazardKeys: Set<string>,
): HaccpCcp[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: 'ccps wajib array' };
  const out: HaccpCcp[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const key = slugKey(String(row.key || ''), `ccp_${i + 1}`);
    const processStepKey = String(row.processStepKey || '').trim();
    const nama = String(row.nama || row.name || '').trim();
    if (!processStepKey) return { error: `ccps[${i}]: processStepKey wajib` };
    if (!nama) return { error: `ccps[${i}]: nama wajib` };
    if (stepKeys.size && !stepKeys.has(processStepKey)) {
      return { error: `ccps[${i}]: processStepKey tidak dikenal` };
    }
    const hz = Array.isArray(row.hazardKeys)
      ? (row.hazardKeys as unknown[]).map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    for (const h of hz) {
      if (hazardKeys.size && !hazardKeys.has(h)) {
        return { error: `ccps[${i}]: hazardKeys "${h}" tidak dikenal` };
      }
    }
    if (seen.has(key)) return { error: `ccps duplikat: ${key}` };
    seen.add(key);
    const cat = row.category != null ? String(row.category).toUpperCase() : undefined;
    out.push({
      key,
      processStepKey,
      hazardKeys: hz,
      nama,
      category: cat as HaccpCategory | undefined,
      monitoringMethod: String(row.monitoringMethod || '').trim() || undefined,
      correctiveAction: String(row.correctiveAction || '').trim() || undefined,
    });
  }
  return out;
}

export function normalizeCriticalLimits(
  raw: unknown,
  ccpKeys: Set<string>,
): HaccpCriticalLimit[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: 'criticalLimits wajib array' };
  const out: HaccpCriticalLimit[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const key = slugKey(String(row.key || ''), `cl_${i + 1}`);
    const parameter = String(row.parameter || '').trim();
    const label = String(row.label || '').trim();
    if (!parameter) return { error: `criticalLimits[${i}]: parameter wajib` };
    if (!label) return { error: `criticalLimits[${i}]: label wajib` };
    const operator = normalizeCriticalLimitOperator(row.operator ?? 'TEXT');
    if (typeof operator !== 'string') {
      return { error: `criticalLimits[${i}]: ${operator.error}` };
    }
    const ccpKey = String(row.ccpKey || '').trim() || undefined;
    if (ccpKey && ccpKeys.size && !ccpKeys.has(ccpKey)) {
      return { error: `criticalLimits[${i}]: ccpKey tidak dikenal` };
    }
    if (operator !== 'TEXT' && row.value != null && Number.isNaN(Number(row.value))) {
      return { error: `criticalLimits[${i}]: value harus angka` };
    }
    if (operator === 'BETWEEN') {
      if (row.value == null || row.valueMax == null) {
        return { error: `criticalLimits[${i}]: BETWEEN butuh value dan valueMax` };
      }
    }
    if (seen.has(key)) return { error: `criticalLimits duplikat: ${key}` };
    seen.add(key);
    out.push({
      key,
      ccpKey,
      processStepKey: String(row.processStepKey || '').trim() || undefined,
      parameter,
      label,
      operator,
      value: row.value != null && row.value !== '' ? Number(row.value) : undefined,
      valueMax: row.valueMax != null && row.valueMax !== '' ? Number(row.valueMax) : undefined,
      unit: String(row.unit || '').trim() || undefined,
      durationMinutes: row.durationMinutes != null && row.durationMinutes !== ''
        ? Number(row.durationMinutes)
        : undefined,
      note: String(row.note || '').trim() || undefined,
    });
  }
  return out;
}

export function normalizeMonitoringPlans(
  raw: unknown,
  ccpKeys: Set<string>,
  limitKeys: Set<string>,
): HaccpMonitoringPlan[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: 'monitoringPlans wajib array' };
  const out: HaccpMonitoringPlan[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const key = slugKey(String(row.key || ''), `mon_${i + 1}`);
    const ccpKey = String(row.ccpKey || '').trim();
    const method = String(row.method || '').trim();
    const frequency = String(row.frequency || '').trim();
    if (!ccpKey) return { error: `monitoringPlans[${i}]: ccpKey wajib` };
    if (!method) return { error: `monitoringPlans[${i}]: method wajib` };
    if (!frequency) return { error: `monitoringPlans[${i}]: frequency wajib` };
    if (ccpKeys.size && !ccpKeys.has(ccpKey)) {
      return { error: `monitoringPlans[${i}]: ccpKey tidak dikenal` };
    }
    const clKeys = Array.isArray(row.criticalLimitKeys)
      ? (row.criticalLimitKeys as unknown[]).map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    for (const ck of clKeys) {
      if (limitKeys.size && !limitKeys.has(ck)) {
        return { error: `monitoringPlans[${i}]: criticalLimitKeys "${ck}" tidak dikenal` };
      }
    }
    if (seen.has(key)) return { error: `monitoringPlans duplikat: ${key}` };
    seen.add(key);
    out.push({
      key,
      ccpKey,
      method,
      frequency,
      responsibleRole: String(row.responsibleRole || '').trim() || undefined,
      criticalLimitKeys: clKeys,
      templateKodeHint: normalizeHaccpTemplateKodeHint(
        String(row.templateKodeHint || '').trim(),
      ) || undefined,
    });
  }
  return out;
}

/** Validasi struktur plan lengkap (referensi silang). */
export function normalizeHaccpPlanEmbedded(input: {
  processSteps?: unknown;
  hazards?: unknown;
  ccps?: unknown;
  criticalLimits?: unknown;
  monitoringPlans?: unknown;
}): {
  processSteps: HaccpProcessStep[];
  hazards: HaccpHazard[];
  ccps: HaccpCcp[];
  criticalLimits: HaccpCriticalLimit[];
  monitoringPlans: HaccpMonitoringPlan[];
} | { error: string } {
  const processSteps = normalizeProcessSteps(input.processSteps);
  if ('error' in processSteps) return processSteps;
  const stepKeys = new Set(processSteps.map((s) => s.key));

  const hazards = normalizeHazards(input.hazards, stepKeys);
  if ('error' in hazards) return hazards;
  const hazardKeys = new Set(hazards.map((h) => h.key));

  const ccps = normalizeCcps(input.ccps, stepKeys, hazardKeys);
  if ('error' in ccps) return ccps;
  const ccpKeys = new Set(ccps.map((c) => c.key));

  const criticalLimits = normalizeCriticalLimits(input.criticalLimits, ccpKeys);
  if ('error' in criticalLimits) return criticalLimits;
  const limitKeys = new Set(criticalLimits.map((c) => c.key));

  const monitoringPlans = normalizeMonitoringPlans(input.monitoringPlans, ccpKeys, limitKeys);
  if ('error' in monitoringPlans) return monitoringPlans;

  return { processSteps, hazards, ccps, criticalLimits, monitoringPlans };
}

/**
 * Parse criticalLimitNote legacy → structured (best-effort).
 * Contoh: "≥ 74°C", "<= 5 C", "2-4 jam", "teks bebas".
 */
export function parseCriticalLimitNote(
  note: string,
  opts?: { key?: string; parameter?: string; label?: string },
): HaccpCriticalLimit {
  const raw = String(note || '').trim();
  const key = opts?.key || 'cl_parsed';
  const parameter = opts?.parameter || 'value';
  const label = opts?.label || raw || 'Critical limit';

  const between = raw.match(/^(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z°%]+)?/);
  if (between) {
    return {
      key,
      parameter,
      label,
      operator: 'BETWEEN',
      value: Number(between[1].replace(',', '.')),
      valueMax: Number(between[2].replace(',', '.')),
      unit: between[3]?.replace('°', '') || undefined,
      note: raw,
    };
  }

  const opMatch = raw.match(/^(≥|>=|>|≤|<=|<|=)\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z°%/]+)?/);
  if (opMatch) {
    const sym = opMatch[1];
    const operator: CriticalLimitOperator =
      sym === '≥' || sym === '>=' ? 'GTE'
        : sym === '>' ? 'GT'
          : sym === '≤' || sym === '<=' ? 'LTE'
            : sym === '<' ? 'LT'
              : 'EQ';
    return {
      key,
      parameter,
      label,
      operator,
      value: Number(opMatch[2].replace(',', '.')),
      unit: opMatch[3]?.replace('°', '') || undefined,
      note: raw,
    };
  }

  return {
    key,
    parameter,
    label,
    operator: 'TEXT',
    note: raw || undefined,
  };
}

export function formatCriticalLimit(limit: HaccpCriticalLimit): string {
  if (limit.operator === 'TEXT') return limit.note || limit.label;
  const op = CRITICAL_LIMIT_OPERATOR_LABELS[limit.operator];
  const unit = limit.unit ? ` ${limit.unit}` : '';
  if (limit.operator === 'BETWEEN') {
    return `${limit.value}${unit} – ${limit.valueMax}${unit}`.trim();
  }
  return `${op} ${limit.value ?? ''}${unit}`.trim();
}

/** Gate sebelum APPROVED/ACTIVE: preamble BGN 8.1–8.5 + inti CCP study. */
export function assertHaccpPlanReadyForApproval(plan: Pick<
  HaccpPlanDoc,
  | 'team'
  | 'scope'
  | 'productDescription'
  | 'intendedUse'
  | 'flowVerifiedAt'
  | 'flowVerifiedBy'
  | 'flowVerifiedByName'
  | 'processSteps'
  | 'hazards'
  | 'ccps'
  | 'criticalLimits'
  | 'monitoringPlans'
>): string | null {
  if (!plan.team?.length) {
    return 'Minimal satu anggota Tim HACCP (langkah Tim & ruang lingkup) sebelum approval';
  }
  for (const m of plan.team) {
    if (!String(m.name || '').trim() || !String(m.role || '').trim()) {
      return 'Setiap anggota tim wajib punya nama dan peran';
    }
  }
  if (!String(plan.scope || '').trim()) {
    return 'Ruang lingkup studi wajib diisi sebelum approval';
  }
  if (!String(plan.productDescription || '').trim()) {
    return 'Deskripsi produk wajib diisi sebelum approval';
  }
  if (!String(plan.intendedUse || '').trim()) {
    return 'Tujuan penggunaan / pengguna wajib diisi sebelum approval';
  }
  if (!plan.processSteps?.length) return 'Minimal satu langkah proses (alur dapur) sebelum approval';
  if (!plan.flowVerifiedAt) {
    return 'Alur proses wajib dikonfirmasi di lapangan sebelum approval';
  }
  if (!String(plan.flowVerifiedByName || plan.flowVerifiedBy || '').trim()) {
    return 'Nama verifikator lapangan wajib diisi sebelum approval';
  }
  if (!plan.hazards?.length) return 'Minimal satu hazard analysis sebelum approval';
  const ccpHazards = plan.hazards.filter((h) => h.isCcp);
  if (!ccpHazards.length) {
    return 'Minimal satu hazard ditandai CCP dengan justifikasi sebelum approval';
  }
  for (const h of ccpHazards) {
    if (!String(h.ccpJustification || '').trim()) {
      return `Hazard ${h.key}: ccpJustification wajib`;
    }
  }
  if (!plan.ccps?.length) return 'Minimal satu CCP sebelum approval';
  for (const ccp of plan.ccps) {
    if (!String(ccp.correctiveAction || '').trim()) {
      return `CCP ${ccp.key}: tindakan korektif (correctiveAction) wajib sebelum approval`;
    }
  }
  if (!plan.criticalLimits?.length) {
    return 'Minimal satu critical limit terstruktur sebelum approval';
  }
  if (!plan.monitoringPlans?.length) {
    return 'Minimal satu monitoring plan sebelum approval';
  }
  return null;
}

/**
 * Samakan hint monitoring plan dengan kode template runtime (HCP-*).
 * Seed lama memakai HACCP-COOK — dinormalisasi ke HCP-COOK.
 */
export function normalizeHaccpTemplateKodeHint(raw: string | undefined | null): string {
  const h = String(raw || '').trim().toUpperCase();
  if (!h) return '';
  if (h === 'HACCP-COOK' || h === 'HCP-COOK') return 'HCP-COOK';
  if (h === 'HACCP-COOL' || h === 'HCP-COOL') return 'HCP-COOL';
  if (h === 'HACCP-HOLD' || h === 'HCP-HOLD') return 'HCP-HOLD';
  if (h === 'HACCP-RECV' || h === 'HCP-RECV' || h === 'HCP-RECEIVE') return 'HCP-RECV';
  if (h.startsWith('HACCP-')) return `HCP-${h.slice('HACCP-'.length)}`;
  return h;
}

export function normalizeHaccpTeam(raw: unknown): HaccpTeamMember[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: 'team wajib array' };
  const out: HaccpTeamMember[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const name = String(r.name || '').trim();
    const role = String(r.role || '').trim();
    if (!name && !role) continue;
    if (!name || !role) return { error: 'Anggota tim: nama dan peran wajib' };
    out.push({
      name,
      role,
      unit: String(r.unit || '').trim() || undefined,
    });
  }
  return out;
}

export function appendHaccpPlanHistory(
  history: DocHistoryEntry[] | undefined,
  entry: DocHistoryEntry,
): DocHistoryEntry[] {
  return appendDocHistory(history, entry);
}

/** Contoh plan memasak — bukan acuan hukum. */
export const EXAMPLE_HACCP_PLAN_COOK: Omit<
  HaccpPlanDoc,
  'id' | 'tenantId' | 'noDokumen' | 'createdAt' | 'updatedAt' | 'history'
> = {
  kode: 'HPL-COOK-EX',
  nama: 'Contoh HACCP Plan — Memasak (CCP Suhu Inti)',
  description: 'Contoh studi untuk dapur SPPG. Validasi ahli wajib sebelum dipakai operasional.',
  version: 1,
  status: 'DRAFT',
  recipeIds: [],
  menuIds: [],
  isExample: true,
  team: [
    { name: 'Contoh Ketua Tim', role: 'Ketua Tim HACCP', unit: 'Mutu' },
    { name: 'Contoh Kepala Dapur', role: 'Kepala Dapur', unit: 'Produksi' },
  ],
  scope: 'Proses memasak menu matang di dapur SPPG contoh — dari penerimaan bahan hingga holding panas.',
  productDescription: 'Menu masakan matang untuk penerima manfaat MBG (contoh).',
  intendedUse: 'Dikonsumsi segera / dalam holding panas oleh anak sekolah dan penerima manfaat rentan.',
  flowDiagramNote: 'Alur: terima → siap → masak → hold → sajikan',
  flowVerifiedAt: new Date('2026-01-15T08:00:00.000Z'),
  flowVerifiedByName: 'Contoh Verifikator Lapangan',
  flowVerifiedNote: 'Dicek di dapur contoh (bukan acuan hukum).',
  processSteps: [
    { key: 'receive', nama: 'Penerimaan bahan', sequence: 1 },
    { key: 'prep', nama: 'Persiapan / pengolahan awal', sequence: 2 },
    { key: 'cook', nama: 'Memasak', sequence: 3 },
    { key: 'hold', nama: 'Holding panas', sequence: 4 },
    { key: 'serve', nama: 'Distribusi / sajian', sequence: 5 },
  ],
  hazards: [
    {
      key: 'hz_pathogen_cook',
      processStepKey: 'cook',
      hazardType: 'BIOLOGICAL',
      description: 'Patogen patogenik tidak mati jika suhu inti tidak tercapai',
      isCcp: true,
      ccpJustification: 'Pengendalian suhu inti adalah titik terakhir yang mencegah hazard biologis sebelum holding/distribusi',
      controlMeasure: 'Pemasakan hingga suhu inti ≥ 74°C',
    },
    {
      key: 'hz_metal_prep',
      processStepKey: 'prep',
      hazardType: 'PHYSICAL',
      description: 'Kontaminan fisik dari peralatan',
      isCcp: false,
      controlMeasure: 'Inspeksi visual & pemeliharaan alat',
    },
  ],
  ccps: [
    {
      key: 'ccp_cook_temp',
      processStepKey: 'cook',
      hazardKeys: ['hz_pathogen_cook'],
      nama: 'Suhu inti masak',
      category: 'CCP_COOK',
      monitoringMethod: 'Ukur suhu inti dengan termometer kalibrasi',
      correctiveAction: 'Lanjut masak / tahan batch / buang sesuai SOP',
    },
  ],
  criticalLimits: [
    {
      key: 'cl_core_temp',
      ccpKey: 'ccp_cook_temp',
      processStepKey: 'cook',
      parameter: 'core_temp',
      label: 'Suhu inti',
      operator: 'GTE',
      value: 74,
      unit: 'C',
      note: '≥ 74°C',
    },
  ],
  monitoringPlans: [
    {
      key: 'mon_cook',
      ccpKey: 'ccp_cook_temp',
      method: 'Pengukuran suhu inti per batch',
      frequency: 'Setiap batch / setiap panci',
      responsibleRole: 'GUDANG',
      criticalLimitKeys: ['cl_core_temp'],
      templateKodeHint: 'HCP-COOK',
    },
  ],
};
