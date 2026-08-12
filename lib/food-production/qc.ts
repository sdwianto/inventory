/**
 * Quality Control — ADR-001 Phase 3.
 * QCR = media pencatatan finding di lapangan (bukan approval PASS-all).
 */

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import { FP_DEFAULT_TRANSITIONS } from '@/lib/food-production/document';

export const QC_TEMPLATES_COLLECTION = 'qc_templates';
export const QC_RESULTS_COLLECTION = 'qc_results';

export type QcCategory = 'PRODUKSI' | 'KEBERSIHAN' | 'DISTRIBUSI';
/** OK = aman, FAIL = ada temuan, NA = tidak dicek. */
export type QcItemResult = 'PASS' | 'FAIL' | 'NA';

export interface QcTemplateItem {
  key: string;
  label: string;
  required?: boolean;
  /** ADR-004 P0C — default mati; hanya FP_MANAGE yang boleh mengaktifkan lewat template. */
  critical?: boolean;
  /** ADR-004 P0C — holdOnFail ⇒ critical. Penahanan batch aktual di P0F. */
  holdOnFail?: boolean;
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
  /** Catatan / deskripsi finding per item. */
  note?: string;
  evidenceUrls?: string[];
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
  /**
   * ADR-004 P0F — opsional. Bila diisi + holdOnFail+FAIL → auto HOLD.
   * Dokumen lama tanpa field tetap valid (jalur proposed hold).
   */
  productionBatchId?: string;
  batchNo?: string;
  /**
   * Mirror usulan batch saat hold tanpa tautan deterministik
   * (sumber otoritatif: ka_safety_cases.proposedHoldBatchIds).
   */
  proposedHoldBatchIds?: string[];
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
    photoCount?: number;
  };
  /** Remark umum sebelum simpan. */
  catatan?: string;
  recordedAt?: Date;
  recordedBy?: string;
  recordedByName?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export const QC_STATUS_TRANSITIONS: Record<string, string[]> = {
  ...FP_DEFAULT_TRANSITIONS,
  DRAFT: ['COMPLETED', 'CANCELLED'],
  SUBMITTED: ['COMPLETED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['COMPLETED', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
  COMPLETED: ['DRAFT', 'CANCELLED'],
};

export const QC_STATUS_LABELS: Record<QcResultStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Draft',
  APPROVED: 'Draft',
  COMPLETED: 'Tercatat',
  CANCELLED: 'Dibatalkan',
};

export const QC_ITEM_RESULT_LABELS: Record<QcItemResult, string> = {
  PASS: 'OK',
  FAIL: 'Ada temuan',
  NA: 'Tidak dicek',
};

/** @deprecated approval flow removed — kept for tests that still import. */
export const QC_UI_STATUS_NEXT: Partial<Record<QcResultStatus, QcResultStatus>> = {};
export const QC_UI_STATUS_NEXT_LABEL: Partial<Record<QcResultStatus, string>> = {};
export const QC_UI_STATUS_PREV: Partial<Record<QcResultStatus, QcResultStatus>> = {};

export const QC_CATEGORY_LABELS: Record<QcCategory, string> = {
  PRODUKSI: 'Produksi',
  KEBERSIHAN: 'Kebersihan',
  DISTRIBUSI: 'Distribusi',
};

/** Editable until cancelled. */
export function isQcEditable(status: string): boolean {
  return status !== 'CANCELLED';
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
    let critical = row.critical === true;
    let holdOnFail = row.holdOnFail === true;
    // Default mati untuk QC (bukan CCP). holdOnFail ⇒ critical.
    if (holdOnFail && !critical) critical = true;
    out.push({
      key,
      label,
      required: row.required !== false,
      critical,
      holdOnFail,
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
    const evidenceUrls = Array.isArray(row?.evidenceUrls)
      ? (row!.evidenceUrls as unknown[]).map((u) => String(u || '').trim()).filter(Boolean)
      : undefined;
    out.push({
      key: t.key,
      label: t.label,
      result,
      note: row?.note != null ? String(row.note).trim() || undefined : undefined,
      evidenceUrls: evidenceUrls?.length ? evidenceUrls.slice(0, 3) : undefined,
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
  let photoCount = 0;
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

/**
 * Findings record — no PASS-all gate.
 * Soft check: at least one item reviewed (PASS/FAIL) or has note/photo.
 */
export function assertQcCanComplete(
  items: QcResultItem[],
  _templateItems: QcTemplateItem[],
): string | null {
  const hasSignal = items.some(
    (i) => i.result === 'PASS' || i.result === 'FAIL'
      || Boolean(i.note?.trim())
      || Boolean(i.evidenceUrls?.length),
  );
  if (!hasSignal) return 'Isi minimal satu finding / status item sebelum simpan';
  return null;
}

/**
 * ADR-004 P0F — item holdOnFail yang FAIL (holdOnFail ⇒ critical).
 * Critical tanpa holdOnFail tidak menahan produk.
 */
export function listQcHoldFailLabels(
  items: QcResultItem[],
  templateItems: QcTemplateItem[],
): string[] {
  const byKey = new Map(templateItems.map((t) => [t.key, t]));
  const labels: string[] = [];
  for (const item of items) {
    if (item.result !== 'FAIL') continue;
    const tpl = byKey.get(item.key);
    if (!tpl?.holdOnFail) continue;
    labels.push(item.label || tpl.label || item.key);
  }
  return labels;
}

export function hasQcHoldCandidate(
  items: QcResultItem[],
  templateItems: QcTemplateItem[],
): boolean {
  return listQcHoldFailLabels(items, templateItems).length > 0;
}

export function buildQcHoldReason(
  labels: string[],
  opts?: { noDokumen?: string; batchNo?: string },
): string {
  const failed = labels.length ? labels.join(', ') : 'QC holdOnFail gagal';
  const parts = [`QC holdOnFail gagal: ${failed}`];
  if (opts?.noDokumen) parts.push(`dok ${opts.noDokumen}`);
  if (opts?.batchNo) parts.push(`batch ${opts.batchNo}`);
  return parts.join(' · ');
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
