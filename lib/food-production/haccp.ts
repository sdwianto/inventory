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

/**
 * ADR-004 P0B — hasil pemeriksaan, sumbu yang terpisah dari `status`.
 * `status` menjawab "berkas sudah sampai mana", `disposition` menjawab
 * "batch-nya aman atau tidak". Keduanya tidak boleh saling mengunci.
 */
export type HaccpDisposition = 'PENDING' | 'PASS' | 'FAIL';

export const HACCP_DISPOSITION_LABELS: Record<HaccpDisposition, string> = {
  PENDING: 'Belum lengkap',
  PASS: 'Lolos',
  FAIL: 'Gagal',
};

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
  /**
   * ADR-004 P0C — kegagalan keamanan pangan (menentukan disposition FAIL).
   * Terpisah dari `required` (kelengkapan isi).
   */
  critical?: boolean;
  /**
   * ADR-004 P0C — kegagalan menahan batch (kandidat HOLD; penahanan aktual di P0D).
   * Invariant: holdOnFail ⇒ critical.
   */
  holdOnFail?: boolean;
}

export function isCcpCategory(category?: string | null): boolean {
  return String(category || '').toUpperCase().startsWith('CCP_');
}

/**
 * Flag efektif setelah P0C.
 * - Field eksplisit dihormati, kecuali invariannya dilanggar.
 * - CCP + required: critical dan holdOnFail selalu true (tidak dapat dimatikan).
 * - Legacy (field belum ada): CCP+required → keduanya true; selain itu false.
 */
export function effectiveHaccpItemFlags(
  item: Pick<HaccpTemplateItem, 'required' | 'critical' | 'holdOnFail'>,
  category?: HaccpCategory | string | null,
): { critical: boolean; holdOnFail: boolean } {
  const ccpRequired = isCcpCategory(category) && item.required !== false;
  let critical = typeof item.critical === 'boolean'
    ? item.critical
    : ccpRequired;
  let holdOnFail = typeof item.holdOnFail === 'boolean'
    ? item.holdOnFail
    : ccpRequired;
  if (ccpRequired) {
    critical = true;
    holdOnFail = true;
  }
  if (holdOnFail) critical = true;
  return { critical, holdOnFail };
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
  /** ADR-004 P0B. Opsional: dokumen lama dibaca lewat effectiveHaccpDisposition(). */
  disposition?: HaccpDisposition;
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

/** Checklist editable until Selesai (gate runs on COMPLETED). */
export function isHaccpEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED' || status === 'APPROVED';
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

/**
 * Normalizer template item + penegakan flag P0C.
 * `category` wajib untuk menegakkan invariansi CCP.
 */
export function normalizeHaccpTemplateItems(
  raw: unknown,
  category?: HaccpCategory | string | null,
): HaccpTemplateItem[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Minimal satu item checklist CCP' };
  const out: HaccpTemplateItem[] = [];
  const seen = new Set<string>();
  const ccp = isCcpCategory(category);
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const key = String(row.key || `ccp_${i + 1}`).trim().toLowerCase().replace(/\s+/g, '_');
    const label = String(row.label || '').trim();
    if (!label) return { error: `Item ${i + 1}: label wajib` };
    if (seen.has(key)) return { error: `Item duplikat: ${key}` };
    seen.add(key);

    const required = row.required !== false;
    // Default: CCP wajib → keduanya true; selain itu false (boleh di-override eksplisit).
    let critical = row.critical === undefined ? (ccp && required) : row.critical === true;
    let holdOnFail = row.holdOnFail === undefined ? (ccp && required) : row.holdOnFail === true;

    if (ccp && required && row.holdOnFail === false) {
      return {
        error: `Item "${label}": CCP wajib tidak boleh holdOnFail=false — turunkan klasifikasi bila tidak menahan produk`,
      };
    }
    if (ccp && required && row.critical === false) {
      return {
        error: `Item "${label}": CCP wajib tidak boleh critical=false`,
      };
    }
    if (ccp && required) {
      critical = true;
      holdOnFail = true;
    }
    if (holdOnFail && !critical) {
      // holdOnFail ⇒ critical — ditegakkan, bukan sekadar konvensi.
      critical = true;
    }

    out.push({
      key,
      label,
      required,
      needsPhoto: row.needsPhoto === true,
      criticalLimitNote: String(row.criticalLimitNote || '').trim() || undefined,
      critical,
      holdOnFail,
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

/**
 * ADR-004 P0C — hitung disposition dari hasil item.
 *
 * Basis final: `critical` (bukan `required`). `required` kembali murni berarti
 * "wajib diisi PASS/FAIL". Legacy tanpa field `critical` diselesaikan lewat
 * effectiveHaccpItemFlags() agar CCP+required lama tetap dibaca kritis.
 *
 * Template kosong diperlakukan sebagai semua item kritis (arah aman).
 */
export function computeHaccpDisposition(
  items: HaccpResultItem[],
  templateItems?: HaccpTemplateItem[],
  category?: HaccpCategory | string | null,
): HaccpDisposition {
  const noTemplate = !templateItems?.length;
  const decisiveKeys = new Set(
    (templateItems || [])
      .filter((t) => effectiveHaccpItemFlags(t, category).critical)
      .map((t) => t.key),
  );
  const isDecisive = (key: string) => noTemplate || decisiveKeys.has(key);

  if (items.some((i) => i.result === 'FAIL' && isDecisive(i.key))) return 'FAIL';

  const decisive = items.filter((i) => isDecisive(i.key));
  const expected = noTemplate ? items.length : decisiveKeys.size;
  if (!expected) return 'PASS';
  if (decisive.length < expected) return 'PENDING';
  return decisive.every((i) => i.result === 'PASS') ? 'PASS' : 'PENDING';
}

/**
 * ADR-004 P0C — kandidat HOLD dari holdOnFail+FAIL.
 * Penahanan aktual ke production_batches dilakukan di P0D.
 */
export function hasHaccpHoldCandidate(
  items: HaccpResultItem[],
  templateItems: HaccpTemplateItem[],
  category?: HaccpCategory | string | null,
): boolean {
  const holdKeys = new Set(
    templateItems
      .filter((t) => effectiveHaccpItemFlags(t, category).holdOnFail)
      .map((t) => t.key),
  );
  return items.some((i) => i.result === 'FAIL' && holdKeys.has(i.key));
}

/** Dokumen lama tanpa field: FAIL kalau ada CCP wajib gagal, selain itu ikut status. */
export function effectiveHaccpDisposition(
  doc: {
    disposition?: HaccpDisposition;
    status?: string;
    summary?: { requiredFailCount?: number };
  } | null | undefined,
): HaccpDisposition {
  const raw = String(doc?.disposition || '').toUpperCase();
  if (raw === 'PENDING' || raw === 'PASS' || raw === 'FAIL') return raw;
  if (Number(doc?.summary?.requiredFailCount || 0) > 0) return 'FAIL';
  // Gate lama menolak COMPLETED bila ada CCP wajib gagal, jadi COMPLETED lama pasti lolos.
  return doc?.status === 'COMPLETED' ? 'PASS' : 'PENDING';
}

/**
 * Filter Mongo yang cocok dengan effectiveHaccpDisposition() — termasuk dokumen
 * lama tanpa field `disposition`. Wajib dipakai di list/attention supaya filter
 * baru tidak "menghilangkan" data historis.
 */
export function haccpDispositionMongoFilter(
  disposition: HaccpDisposition,
): Record<string, unknown> {
  const legacyNoFail = {
    $or: [
      { 'summary.requiredFailCount': { $exists: false } },
      { 'summary.requiredFailCount': { $lte: 0 } },
    ],
  };
  if (disposition === 'FAIL') {
    return {
      $or: [
        { disposition: 'FAIL' },
        { disposition: { $exists: false }, 'summary.requiredFailCount': { $gt: 0 } },
      ],
    };
  }
  if (disposition === 'PASS') {
    return {
      $or: [
        { disposition: 'PASS' },
        { $and: [{ disposition: { $exists: false } }, { status: 'COMPLETED' }, legacyNoFail] },
      ],
    };
  }
  return {
    $or: [
      { disposition: 'PENDING' },
      {
        $and: [
          { disposition: { $exists: false } },
          { status: { $ne: 'COMPLETED' } },
          legacyNoFail,
        ],
      },
    ],
  };
}

/**
 * Gate sebelum COMPLETED — kelengkapan pengisian, bukan hasilnya.
 *
 * ADR-004 P0B: CCP gagal TIDAK lagi memblokir COMPLETED. Dokumen gagal wajib
 * bisa diselesaikan sebagai catatan kegagalan formal; memblokirnya hanya
 * membuat dokumen menggantung dan kegagalan tidak pernah tercatat resmi.
 * Konsekuensi penahanan batch ditangani lewat `disposition`, bukan lewat
 * penolakan transisi status.
 */
export function assertHaccpCanComplete(
  items: HaccpResultItem[],
  templateItems: HaccpTemplateItem[],
  docEvidenceUrls: string[] = [],
): string | null {
  for (const t of templateItems) {
    if (t.required === false) continue;
    const item = items.find((i) => i.key === t.key);
    if (!item) return `CCP wajib "${t.label}" belum diisi`;
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
        critical: true,
        holdOnFail: true,
      },
      {
        key: 'hold_time',
        label: 'Waktu tahan panas sesuai SOP',
        required: true,
        critical: true,
        holdOnFail: true,
      },
      {
        // Contoh ADR: critical tanpa hold — temuan operasional, tidak menahan batch.
        key: 'thermometer_cal',
        label: 'Termometer terkalibrasi',
        required: false,
        critical: true,
        holdOnFail: false,
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
        critical: true,
        holdOnFail: true,
      },
      {
        key: 'cool_4h',
        label: 'Pendinginan 21→5°C dalam 4 jam',
        required: true,
        criticalLimitNote: '≤ 4 jam',
        critical: true,
        holdOnFail: true,
      },
      {
        key: 'storage_label',
        label: 'Label batch & waktu pendinginan',
        required: true,
        needsPhoto: true,
        critical: true,
        holdOnFail: true,
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
        critical: true,
        holdOnFail: true,
      },
      {
        key: 'hold_duration',
        label: 'Durasi holding dalam batas aman',
        required: true,
        critical: true,
        holdOnFail: true,
      },
    ],
  },
];
