/**
 * HACCP evidence — ADR-001 Phase 5 / Sprint 21.
 * Checklist CCP kritis + evidence foto (reuse media storage) per batch.
 */

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import { FP_DEFAULT_TRANSITIONS } from '@/lib/food-production/document';

export const HACCP_TEMPLATES_COLLECTION = 'haccp_templates';
export const HACCP_RESULTS_COLLECTION = 'haccp_results';

export type HaccpCategory =
  | 'CCP_COOK'
  | 'CCP_COOL'
  | 'CCP_HOLD'
  | 'CCP_RECEIVE'
  | 'CCP_DIST'
  | 'OTHER';

export type HaccpItemResult = 'PASS' | 'FAIL' | 'NA';

export type HaccpResultStatus = Extract<
  FpDocStatus,
  'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'COMPLETED' | 'CANCELLED'
>;

export interface HaccpTemplateItem {
  key: string;
  label: string;
  required?: boolean;
  needsPhoto?: boolean;
  criticalLimitNote?: string;
}

export interface HaccpTemplateDoc {
  id: string;
  tenantId: string;
  kode: string;
  nama: string;
  category: HaccpCategory;
  items: HaccpTemplateItem[];
  aktif: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface HaccpResultItem {
  key: string;
  label: string;
  result: HaccpItemResult;
  note?: string;
  evidenceUrls?: string[];
}

export interface HaccpResultDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  templateId: string;
  templateKode?: string;
  templateNama?: string;
  category: HaccpCategory;
  productionBatchId: string;
  batchNo?: string;
  productionPlanId?: string;
  productionPlanNo?: string;
  productionResultId?: string;
  productionResultNo?: string;
  kitchenId?: string;
  kitchenNama?: string;
  tanggal: string;
  items: HaccpResultItem[];
  evidenceUrls: string[];
  evidenceMediaFiles: string[];
  linkedQcResultId?: string;
  status: HaccpResultStatus;
  history: DocHistoryEntry[];
  summary: {
    passCount: number;
    failCount: number;
    naCount: number;
    requiredFailCount: number;
    photoCount: number;
  };
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export const HACCP_STATUS_TRANSITIONS: Record<string, string[]> = {
  ...FP_DEFAULT_TRANSITIONS,
  APPROVED: ['COMPLETED', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
};

export const HACCP_STATUS_LABELS: Record<HaccpResultStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Diajukan',
  APPROVED: 'Disetujui',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};

export const HACCP_CATEGORY_LABELS: Record<HaccpCategory, string> = {
  CCP_COOK: 'CCP Memasak',
  CCP_COOL: 'CCP Pendinginan',
  CCP_HOLD: 'CCP Holding',
  CCP_RECEIVE: 'CCP Penerimaan',
  CCP_DIST: 'CCP Distribusi',
  OTHER: 'Lainnya',
};

export const HACCP_UI_STATUS_NEXT: Partial<Record<HaccpResultStatus, HaccpResultStatus>> = {
  DRAFT: 'SUBMITTED',
  SUBMITTED: 'APPROVED',
  APPROVED: 'COMPLETED',
};

export function isHaccpEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED';
}

export function normalizeHaccpCategory(raw: unknown): HaccpCategory | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (
    v === 'CCP_COOK'
    || v === 'CCP_COOL'
    || v === 'CCP_HOLD'
    || v === 'CCP_RECEIVE'
    || v === 'CCP_DIST'
    || v === 'OTHER'
  ) {
    return v;
  }
  return { error: 'category wajib CCP_COOK|CCP_COOL|CCP_HOLD|CCP_RECEIVE|CCP_DIST|OTHER' };
}

export function normalizeHaccpTemplateItems(
  raw: unknown,
): HaccpTemplateItem[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Minimal satu item checklist CCP' };
  const out: HaccpTemplateItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const key = String(row.key || `ccp_${i + 1}`).trim().toLowerCase().replace(/\s+/g, '_');
    const label = String(row.label || '').trim();
    if (!label) return { error: `Item ${i + 1}: label wajib` };
    if (seen.has(key)) return { error: `Item duplikat: ${key}` };
    seen.add(key);
    out.push({
      key,
      label,
      required: row.required !== false,
      needsPhoto: row.needsPhoto === true,
      criticalLimitNote: String(row.criticalLimitNote || '').trim() || undefined,
    });
  }
  return out;
}

export function normalizeHaccpResultItems(
  raw: unknown,
  templateItems: HaccpTemplateItem[],
): HaccpResultItem[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'items wajib array' };
  const byKey = new Map(
    (raw as Record<string, unknown>[]).map((r) => [String(r.key || '').trim(), r]),
  );
  const out: HaccpResultItem[] = [];
  for (const t of templateItems) {
    const row = byKey.get(t.key);
    const resultRaw = String(row?.result || 'NA').toUpperCase();
    const result: HaccpItemResult =
      resultRaw === 'PASS' || resultRaw === 'FAIL' || resultRaw === 'NA' ? resultRaw : 'NA';
    const evidenceUrls = Array.isArray(row?.evidenceUrls)
      ? (row.evidenceUrls as unknown[]).map((u) => String(u || '').trim()).filter(Boolean)
      : undefined;
    out.push({
      key: t.key,
      label: t.label,
      result,
      note: row?.note != null ? String(row.note).trim() || undefined : undefined,
      evidenceUrls: evidenceUrls?.length ? evidenceUrls : undefined,
    });
  }
  return out;
}

export function summarizeHaccpItems(
  items: HaccpResultItem[],
  templateItems?: HaccpTemplateItem[],
  docEvidenceUrls?: string[],
): HaccpResultDoc['summary'] {
  const requiredKeys = new Set(
    (templateItems || []).filter((t) => t.required !== false).map((t) => t.key),
  );
  let passCount = 0;
  let failCount = 0;
  let naCount = 0;
  let requiredFailCount = 0;
  let photoCount = (docEvidenceUrls || []).length;
  for (const item of items) {
    if (item.result === 'PASS') passCount += 1;
    else if (item.result === 'FAIL') {
      failCount += 1;
      if (requiredKeys.has(item.key) || !templateItems?.length) requiredFailCount += 1;
    } else naCount += 1;
    photoCount += (item.evidenceUrls || []).length;
  }
  return { passCount, failCount, naCount, requiredFailCount, photoCount };
}

/** Soft gate before COMPLETED — required PASS + needsPhoto has evidence. */
export function assertHaccpCanComplete(
  items: HaccpResultItem[],
  templateItems: HaccpTemplateItem[],
  docEvidenceUrls: string[] = [],
): string | null {
  for (const t of templateItems) {
    if (t.required === false) continue;
    const item = items.find((i) => i.key === t.key);
    if (!item) return `CCP wajib "${t.label}" belum diisi`;
    if (item.result === 'FAIL') return `CCP wajib gagal: ${t.label}`;
    if (item.result === 'NA') return `CCP wajib "${t.label}" harus PASS/FAIL`;
    if (t.needsPhoto) {
      const photos = [
        ...(item.evidenceUrls || []),
        ...docEvidenceUrls,
      ];
      if (!photos.length) {
        return `CCP "${t.label}" wajib evidence foto`;
      }
    }
  }
  return null;
}

export const DEFAULT_HACCP_TEMPLATES: Array<{
  kode: string;
  nama: string;
  category: HaccpCategory;
  items: HaccpTemplateItem[];
}> = [
  {
    kode: 'HCP-COOK',
    nama: 'CCP Suhu Inti Masak',
    category: 'CCP_COOK',
    items: [
      {
        key: 'core_temp',
        label: 'Suhu inti ≥ 74°C tercapai',
        required: true,
        needsPhoto: true,
        criticalLimitNote: '≥ 74°C',
      },
      {
        key: 'hold_time',
        label: 'Waktu tahan panas sesuai SOP',
        required: true,
      },
      {
        key: 'thermometer_cal',
        label: 'Termometer terkalibrasi',
        required: false,
      },
    ],
  },
  {
    kode: 'HCP-COOL',
    nama: 'CCP Pendinginan',
    category: 'CCP_COOL',
    items: [
      {
        key: 'cool_2h',
        label: 'Pendinginan 60→21°C dalam 2 jam',
        required: true,
        needsPhoto: true,
        criticalLimitNote: '≤ 2 jam',
      },
      {
        key: 'cool_4h',
        label: 'Pendinginan 21→5°C dalam 4 jam',
        required: true,
        criticalLimitNote: '≤ 4 jam',
      },
      {
        key: 'storage_label',
        label: 'Label batch & waktu pendinginan',
        required: true,
        needsPhoto: true,
      },
    ],
  },
  {
    kode: 'HCP-HOLD',
    nama: 'CCP Holding Panas',
    category: 'CCP_HOLD',
    items: [
      {
        key: 'hold_temp',
        label: 'Holding ≥ 60°C',
        required: true,
        needsPhoto: true,
        criticalLimitNote: '≥ 60°C',
      },
      {
        key: 'hold_duration',
        label: 'Durasi holding dalam batas aman',
        required: true,
      },
    ],
  },
];
