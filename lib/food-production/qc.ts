/**
 * Quality Control — ADR-001 Phase 3.
 * Checklist sederhana (bukan ISO) untuk dapur / distribusi.
 */

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import { FP_DEFAULT_TRANSITIONS } from '@/lib/food-production/document';

export const QC_TEMPLATES_COLLECTION = 'qc_templates';
export const QC_RESULTS_COLLECTION = 'qc_results';

export type QcCategory = 'PRODUKSI' | 'KEBERSIHAN' | 'DISTRIBUSI';
export type QcItemResult = 'PASS' | 'FAIL' | 'NA';

export interface QcTemplateItem {
  key: string;
  label: string;
  required?: boolean;
}

export interface QcTemplateDoc {
  id: string;
  tenantId: string;
  kode: string;
  nama: string;
  category: QcCategory;
  items: QcTemplateItem[];
  aktif: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface QcResultItem {
  key: string;
  label: string;
  result: QcItemResult;
  note?: string;
}

export type QcResultStatus = Extract<FpDocStatus, 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'COMPLETED' | 'CANCELLED'>;

export interface QcResultDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  templateId: string;
  templateKode?: string;
  templateNama?: string;
  category: QcCategory;
  productionPlanId?: string;
  productionPlanNo?: string;
  kitchenId?: string;
  kitchenNama?: string;
  tanggal: string;
  items: QcResultItem[];
  status: QcResultStatus;
  history: DocHistoryEntry[];
  summary: {
    passCount: number;
    failCount: number;
    naCount: number;
    requiredFailCount: number;
  };
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export const QC_STATUS_TRANSITIONS: Record<string, string[]> = {
  ...FP_DEFAULT_TRANSITIONS,
  APPROVED: ['COMPLETED', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
};

export const QC_STATUS_LABELS: Record<QcResultStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Diajukan',
  APPROVED: 'Disetujui',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};

/** Primary UI path for QC results. */
export const QC_UI_STATUS_NEXT: Partial<Record<QcResultStatus, QcResultStatus>> = {
  DRAFT: 'SUBMITTED',
  SUBMITTED: 'APPROVED',
  APPROVED: 'COMPLETED',
};

export const QC_UI_STATUS_NEXT_LABEL: Partial<Record<QcResultStatus, string>> = {
  DRAFT: 'Ajukan',
  SUBMITTED: 'Setujui',
  APPROVED: 'Selesai',
};

export const QC_CATEGORY_LABELS: Record<QcCategory, string> = {
  PRODUKSI: 'Produksi',
  KEBERSIHAN: 'Kebersihan',
  DISTRIBUSI: 'Distribusi',
};

export function isQcEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED';
}

export function normalizeQcTemplateItems(raw: unknown): QcTemplateItem[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Minimal satu item checklist' };
  const out: QcTemplateItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const key = String(row.key || `item_${i + 1}`).trim().toLowerCase().replace(/\s+/g, '_');
    const label = String(row.label || '').trim();
    if (!label) return { error: `Item ${i + 1}: label wajib` };
    if (seen.has(key)) return { error: `Item duplikat: ${key}` };
    seen.add(key);
    out.push({
      key,
      label,
      required: row.required !== false,
    });
  }
  return out;
}

export function normalizeQcCategory(raw: unknown): QcCategory | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (v === 'PRODUKSI' || v === 'KEBERSIHAN' || v === 'DISTRIBUSI') return v;
  return { error: 'category wajib PRODUKSI | KEBERSIHAN | DISTRIBUSI' };
}

export function normalizeQcResultItems(
  raw: unknown,
  templateItems: QcTemplateItem[],
): QcResultItem[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'items wajib array' };
  const byKey = new Map(
    (raw as Record<string, unknown>[]).map((r) => [String(r.key || '').trim(), r]),
  );
  const out: QcResultItem[] = [];
  for (const t of templateItems) {
    const row = byKey.get(t.key);
    const resultRaw = String(row?.result || 'NA').toUpperCase();
    const result: QcItemResult =
      resultRaw === 'PASS' || resultRaw === 'FAIL' || resultRaw === 'NA' ? resultRaw : 'NA';
    if (t.required && result === 'NA' && row?.result != null) {
      // allow NA only if explicitly set; on complete we gate fail/required separately
    }
    out.push({
      key: t.key,
      label: t.label,
      result,
      note: row?.note != null ? String(row.note).trim() || undefined : undefined,
    });
  }
  return out;
}

export function summarizeQcItems(
  items: QcResultItem[],
  templateItems?: QcTemplateItem[],
): QcResultDoc['summary'] {
  const requiredKeys = new Set((templateItems || []).filter((t) => t.required !== false).map((t) => t.key));
  let passCount = 0;
  let failCount = 0;
  let naCount = 0;
  let requiredFailCount = 0;
  for (const item of items) {
    if (item.result === 'PASS') passCount += 1;
    else if (item.result === 'FAIL') {
      failCount += 1;
      if (requiredKeys.has(item.key) || !templateItems?.length) requiredFailCount += 1;
    } else naCount += 1;
  }
  return { passCount, failCount, naCount, requiredFailCount };
}

/** Soft gate before COMPLETED — required items must not be FAIL (NA ok with warning in UI). */
export function assertQcCanComplete(
  items: QcResultItem[],
  templateItems: QcTemplateItem[],
): string | null {
  for (const t of templateItems) {
    if (t.required === false) continue;
    const item = items.find((i) => i.key === t.key);
    if (!item) return `Item wajib "${t.label}" belum diisi`;
    if (item.result === 'FAIL') return `Item wajib gagal: ${t.label}`;
    if (item.result === 'NA') return `Item wajib "${t.label}" harus PASS/FAIL`;
  }
  return null;
}

export const DEFAULT_QC_TEMPLATES: Array<{
  kode: string;
  nama: string;
  category: QcCategory;
  items: QcTemplateItem[];
}> = [
  {
    kode: 'QC-PROD',
    nama: 'Checklist Produksi',
    category: 'PRODUKSI',
    items: [
      { key: 'suhu_masak', label: 'Suhu masak sesuai standar', required: true },
      { key: 'rasa_tekstur', label: 'Rasa & tekstur OK', required: true },
      { key: 'porsi_visual', label: 'Porsi visual sesuai sampel', required: true },
      { key: 'label_batch', label: 'Label batch terpasang', required: false },
    ],
  },
  {
    kode: 'QC-HYG',
    nama: 'Checklist Kebersihan',
    category: 'KEBERSIHAN',
    items: [
      { key: 'cuci_tangan', label: 'Cuci tangan / APD lengkap', required: true },
      { key: 'area_bersih', label: 'Area produksi bersih', required: true },
      { key: 'alat_bersih', label: 'Peralatan bersih sebelum pakai', required: true },
      { key: 'sampah', label: 'Sampah tertutup & terjadwal', required: false },
    ],
  },
  {
    kode: 'QC-DIST',
    nama: 'Checklist Distribusi',
    category: 'DISTRIBUSI',
    items: [
      { key: 'kemasan_rapat', label: 'Kemasan rapat & higienis', required: true },
      { key: 'suhu_simpan', label: 'Suhu simpan/angkut aman', required: true },
      { key: 'waktu_kirim', label: 'Waktu kirim sesuai jadwal', required: true },
      { key: 'dokumentasi', label: 'Dokumentasi serah terima', required: false },
    ],
  },
];
