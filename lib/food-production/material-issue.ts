/**
 * Material Issue (PBL) — ADR-001 Phase 2.
 * Ambil bahan dari gudang dapur terhadap Production Plan.
 */

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import { FP_DEFAULT_TRANSITIONS, FP_OPEN_DOC_STATUSES } from '@/lib/food-production/document';
import type { MaterialRequirementLine } from '@/lib/food-production/material-requirement';
import { roundQty } from '@/lib/food-production/material-requirement';

export const MATERIAL_ISSUES_COLLECTION = 'material_issues';

export type MaterialIssueStatus = FpDocStatus;

export interface MaterialIssueLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  /** Product warehouse (GKERING / GBASAH) — where stock is deducted on post. */
  warehouseKode?: string;
  qtyPlanned: number;
  /** PBL acuan (`stockMode: 'REFERENCE'`): selalu 0 — bahan keluar lewat RL. */
  qtyIssued: number;
  /** Snapshot acuan (PBL acuan). Semua qty dalam satuan dasar produk. */
  productIds?: string[];
  sumber?: 'PO' | 'MRP';
  acuanQty?: number;
  poQtyReceived?: number;
  rlPosted?: number;
  /** PBL lama yang memutasi stok untuk rencana yang sama. */
  pblPosted?: number;
  sisa?: number;
}

/** `REFERENCE`: PBL sebagai dokumen acuan & konfirmasi, tanpa mutasi stok (Fase 1.4). Kosong = lama (memutasi stok). */
export type MaterialIssueStockMode = 'STOCK' | 'REFERENCE';

export interface MaterialIssueDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  productionPlanId: string;
  productionPlanNo?: string;
  materialRequirementId?: string;
  materialRequirementNo?: string;
  tanggal: string;
  kitchenId: string;
  kitchenNama?: string;
  warehouseKode: string;
  lines: MaterialIssueLine[];
  status: MaterialIssueStatus;
  history: DocHistoryEntry[];
  summary: {
    lineCount: number;
    qtyPlannedTotal: number;
    qtyIssuedTotal: number;
    /** PBL acuan. */
    rlPostedTotal?: number;
    sisaTotal?: number;
    sisaLineCount?: number;
  };
  stockMode?: MaterialIssueStockMode;
  /** PBL acuan: waktu snapshot acuan terakhir (buat / perbarui / selesai). */
  referenceSnapshotAt?: Date;
  /** PBL acuan selesai padahal masih ada sisa acuan atau RL menunggu persetujuan. */
  completionAck?: {
    by?: { userId?: string; userName?: string };
    at: Date;
    reason: string;
    sisaLineCount: number;
    pendingRlCount: number;
  };
  /** Hanya PBL lama: waktu stok diposting. PBL acuan tidak pernah mengisi ini. */
  stockPostedAt?: Date;
  /** W2-6: FEFO consume summary per line (ingredient_lots). */
  fefoConsume?: Array<{
    stokId: string;
    warehouseKode: string;
    needQty: number;
    allocated: number;
    shortfall: number;
    skippedNoLots: boolean;
    allocations?: unknown[];
  }>;
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
  /**
   * Terisi kalau Issue ini dibuat saat bahan belum lengkap (blokir lunak —
   * admin sadar memilih lanjut + wajib isi alasan). Operasional lapangan
   * tidak selalu butuh semua bahan resep 100% terpenuhi.
   */
  shortageOverride?: {
    by?: { userId?: string; userName?: string };
    at: Date;
    reason: string;
    shortageCount: number;
    shortageLines: Array<{
      productId: string;
      productKode?: string;
      productNama?: string;
      qtyNet?: number;
      satuan?: string;
    }>;
  };
  /** Penutupan administratif: semua qtyIssued=0, bahan sudah keluar via RL. */
  closureOnly?: {
    by?: { userId?: string; userName?: string };
    at: Date;
    reason: string;
  };
}

export const ISSUE_ELIGIBLE_PLAN_STATUSES = new Set(['APPROVED', 'PROCESSING']);

export const ISSUE_OPEN_STATUSES = FP_OPEN_DOC_STATUSES;

export function isIssueEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED';
}

/** Dapat sinkron qty dari stok & release operasional sebelum post stok. */
export function isIssueReconcilable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED' || status === 'APPROVED' || status === 'PROCESSING';
}

export function buildIssueLinesFromMrp(
  mrpLines: Array<
    Pick<MaterialRequirementLine, 'productId' | 'productKode' | 'productNama' | 'satuan' | 'qtyGross'>
    & { stockWarehouseKode?: string; warehouseKode?: string }
  >,
): MaterialIssueLine[] {
  return (mrpLines || [])
    .filter((l) => String(l.productId || '').trim() && Number.isFinite(Number(l.qtyGross)) && Number(l.qtyGross) > 0)
    .map((l) => {
      const qty = roundQty(Number(l.qtyGross));
      const warehouseKode = String(l.stockWarehouseKode || l.warehouseKode || '').trim() || undefined;
      return {
        productId: String(l.productId).trim(),
        productKode: l.productKode,
        productNama: l.productNama,
        satuan: l.satuan,
        warehouseKode,
        qtyPlanned: qty,
        qtyIssued: qty,
      };
    })
    .sort((a, b) =>
      String(a.productNama || a.productKode || a.productId).localeCompare(
        String(b.productNama || b.productKode || b.productId),
        'id',
      ),
    );
}

export function summarizeIssueLines(lines: MaterialIssueLine[]): MaterialIssueDoc['summary'] {
  return {
    lineCount: lines.length,
    qtyPlannedTotal: roundQty(lines.reduce((s, l) => s + (Number(l.qtyPlanned) || 0), 0)),
    qtyIssuedTotal: roundQty(lines.reduce((s, l) => s + (Number(l.qtyIssued) || 0), 0)),
  };
}

export function isReferenceIssue(doc: Pick<MaterialIssueDoc, 'stockMode'> | null | undefined): boolean {
  return doc?.stockMode === 'REFERENCE';
}

/** Filter Mongo: PBL yang benar-benar memutasi stok (lama). */
export const STOCK_ISSUE_FILTER = { stockMode: { $ne: 'REFERENCE' } } as const;

type ReferenceLineInput = {
  productId: string;
  productIds: string[];
  productKode?: string;
  productNama?: string;
  satuan?: string;
  sumber: 'PO' | 'MRP';
  acuanQty: number;
  poQtyReceived: number;
  rlPosted: number;
  pblPosted: number;
  sisa: number;
  stockWarehouseKode?: string;
};

/** Baris PBL acuan dari `loadPlanReference` — qty keluar 0, acuan/RL/sisa sebagai snapshot. */
export function buildReferenceIssueLines(refLines: ReferenceLineInput[]): MaterialIssueLine[] {
  return refLines
    .filter((l) => l.acuanQty > 0 || l.rlPosted > 0 || l.pblPosted > 0)
    .map((l) => ({
      productId: l.productId,
      productIds: l.productIds,
      productKode: l.productKode,
      productNama: l.productNama,
      satuan: l.satuan,
      ...(l.stockWarehouseKode ? { warehouseKode: l.stockWarehouseKode } : {}),
      qtyPlanned: roundQty(l.acuanQty),
      qtyIssued: 0,
      sumber: l.sumber,
      acuanQty: roundQty(l.acuanQty),
      poQtyReceived: roundQty(l.poQtyReceived),
      rlPosted: roundQty(l.rlPosted),
      pblPosted: roundQty(l.pblPosted),
      sisa: roundQty(l.sisa),
    }));
}

export function summarizeReferenceIssueLines(lines: MaterialIssueLine[]): MaterialIssueDoc['summary'] {
  return {
    ...summarizeIssueLines(lines),
    rlPostedTotal: roundQty(lines.reduce((s, l) => s + (Number(l.rlPosted) || 0), 0)),
    sisaTotal: roundQty(lines.reduce((s, l) => s + (Number(l.sisa) || 0), 0)),
    sisaLineCount: lines.filter((l) => (Number(l.sisa) || 0) > 0).length,
  };
}

export function normalizeIssueLines(raw: unknown): MaterialIssueLine[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length) {
    return { error: 'Minimal satu baris bahan' };
  }
  const out: MaterialIssueLine[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const productId = String(row.productId || '').trim();
    const qtyPlanned = Number(row.qtyPlanned);
    const qtyIssued = Number(row.qtyIssued);
    if (!productId) return { error: `Baris ${i + 1}: productId wajib` };
    if (!Number.isFinite(qtyPlanned) || qtyPlanned < 0) {
      return { error: `Baris ${i + 1}: qtyPlanned tidak valid` };
    }
    if (!Number.isFinite(qtyIssued) || qtyIssued < 0) {
      return { error: `Baris ${i + 1}: qtyIssued tidak valid` };
    }
    if (seen.has(productId)) return { error: `Produk duplikat pada baris ${i + 1}` };
    seen.add(productId);
    out.push({
      productId,
      productKode: row.productKode != null ? String(row.productKode) : undefined,
      productNama: row.productNama != null ? String(row.productNama) : undefined,
      satuan: row.satuan != null ? String(row.satuan) : undefined,
      warehouseKode: row.warehouseKode != null ? String(row.warehouseKode).trim() || undefined : undefined,
      qtyPlanned: roundQty(qtyPlanned),
      qtyIssued: roundQty(qtyIssued),
    });
  }
  return out;
}

export const ISSUE_STATUS_LABELS: Record<MaterialIssueStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Diajukan',
  APPROVED: 'Disetujui',
  PROCESSING: 'Diproses',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};

/** Issue may go APPROVED → COMPLETED (stock post) without mandatory PROCESSING step. */
export const ISSUE_STATUS_TRANSITIONS: Record<string, string[]> = {
  ...FP_DEFAULT_TRANSITIONS,
  APPROVED: ['PROCESSING', 'COMPLETED', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
};

/** Primary UI path (APPROVED may skip PROCESSING). */
export const ISSUE_UI_STATUS_NEXT: Partial<Record<MaterialIssueStatus, MaterialIssueStatus>> = {
  DRAFT: 'SUBMITTED',
  SUBMITTED: 'APPROVED',
  APPROVED: 'COMPLETED',
  PROCESSING: 'COMPLETED',
};

export const ISSUE_UI_STATUS_NEXT_LABEL: Partial<Record<MaterialIssueStatus, string>> = {
  DRAFT: 'Ajukan',
  SUBMITTED: 'Setujui',
  APPROVED: 'Keluarkan Stok',
  PROCESSING: 'Keluarkan Stok',
};

/** Parse plan tanggal for period lock (noon UTC avoids date-only timezone skew). */
export function postingDateFromIso(tanggal: string): Date {
  const raw = String(tanggal || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T12:00:00.000Z`);
  }
  return new Date(raw);
}
