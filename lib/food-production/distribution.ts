/**
 * Distribution Order / Packing list — ADR-001 Phase 5 / Sprint 19.
 * Packing dari Plan (target) atau HSL (actual) ke titik layanan.
 * PROCESSING = dikemas/dikirim; COMPLETED = diterima di titik.
 * Tanpa mutasi stok (stok FG sudah masuk saat HSL COMPLETE).
 */

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import { FP_DEFAULT_TRANSITIONS } from '@/lib/food-production/document';
import { roundQty } from '@/lib/food-production/material-requirement';

export const DISTRIBUTION_ORDERS_COLLECTION = 'distribution_orders';

export type DistributionSourceType = 'PLAN' | 'RESULT';
export type DistributionStatus = FpDocStatus;

export interface DistributionLine {
  servicePointId: string;
  servicePointKode?: string;
  servicePointNama?: string;
  menuId?: string;
  menuKode?: string;
  menuNama?: string;
  finishedGoodProductId?: string;
  finishedGoodKode?: string;
  finishedGoodNama?: string;
  qtyPorsi: number;
  notes?: string;
}

export interface DistributionOrderDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  tanggal: string;
  kitchenId: string;
  kitchenNama?: string;
  sourceType: DistributionSourceType;
  productionPlanId?: string;
  productionPlanNo?: string;
  productionResultId?: string;
  productionResultNo?: string;
  lines: DistributionLine[];
  status: DistributionStatus;
  history: DocHistoryEntry[];
  summary: {
    lineCount: number;
    qtyPorsiTotal: number;
    servicePointCount: number;
  };
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

/** APPROVED → PROCESSING (kirim) wajib; tidak loncat ke COMPLETED. */
export const DIST_STATUS_TRANSITIONS: Record<string, string[]> = {
  ...FP_DEFAULT_TRANSITIONS,
  APPROVED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
};

export const DIST_STATUS_LABELS: Record<DistributionStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Diajukan',
  APPROVED: 'Disetujui',
  PROCESSING: 'Dikirim',
  COMPLETED: 'Diterima',
  CANCELLED: 'Dibatalkan',
};

export const DIST_UI_STATUS_NEXT: Partial<Record<DistributionStatus, DistributionStatus>> = {
  DRAFT: 'SUBMITTED',
  SUBMITTED: 'APPROVED',
  APPROVED: 'PROCESSING',
  PROCESSING: 'COMPLETED',
};

export const DIST_UI_STATUS_NEXT_LABEL: Partial<Record<DistributionStatus, string>> = {
  DRAFT: 'Ajukan',
  SUBMITTED: 'Setujui',
  APPROVED: 'Kirim',
  PROCESSING: 'Terima',
};

export function isDistEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED';
}

export function summarizeDistLines(lines: DistributionLine[]) {
  const points = new Set(lines.map((l) => l.servicePointId).filter(Boolean));
  return {
    lineCount: lines.length,
    qtyPorsiTotal: roundQty(lines.reduce((s, l) => s + (Number(l.qtyPorsi) || 0), 0)),
    servicePointCount: points.size,
  };
}

export function normalizeDistLines(raw: unknown): DistributionLine[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Minimal satu baris distribusi' };
  const out: DistributionLine[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const servicePointId = String(row.servicePointId || '').trim();
    const qtyPorsi = Number(row.qtyPorsi);
    if (!servicePointId) return { error: `Baris ${i + 1}: servicePointId wajib` };
    if (!Number.isFinite(qtyPorsi) || qtyPorsi <= 0) {
      return { error: `Baris ${i + 1}: qtyPorsi harus > 0` };
    }
    const menuId = row.menuId != null ? String(row.menuId).trim() || undefined : undefined;
    const fgId = row.finishedGoodProductId != null
      ? String(row.finishedGoodProductId).trim() || undefined
      : undefined;
    const key = `${servicePointId}|${menuId || ''}|${fgId || ''}`;
    if (seen.has(key)) return { error: `Baris ${i + 1}: duplikat titik × menu/FG` };
    seen.add(key);
    out.push({
      servicePointId,
      servicePointKode: row.servicePointKode != null ? String(row.servicePointKode) : undefined,
      servicePointNama: row.servicePointNama != null ? String(row.servicePointNama) : undefined,
      menuId,
      menuKode: row.menuKode != null ? String(row.menuKode) : undefined,
      menuNama: row.menuNama != null ? String(row.menuNama) : undefined,
      finishedGoodProductId: fgId,
      finishedGoodKode: row.finishedGoodKode != null ? String(row.finishedGoodKode) : undefined,
      finishedGoodNama: row.finishedGoodNama != null ? String(row.finishedGoodNama) : undefined,
      qtyPorsi: roundQty(qtyPorsi),
      notes: row.notes != null ? String(row.notes) : undefined,
    });
  }
  return out;
}

/** Build draft packing lines: each plan/result line × each service point (equal split). */
export function allocatePorsiAcrossPoints(input: {
  items: Array<{
    menuId?: string;
    menuKode?: string;
    menuNama?: string;
    finishedGoodProductId?: string;
    finishedGoodKode?: string;
    finishedGoodNama?: string;
    qtyPorsi: number;
  }>;
  servicePoints: Array<{
    id: string;
    kode?: string;
    nama: string;
    kapasitasPorsi?: number;
  }>;
}): DistributionLine[] | { error: string } {
  if (!input.items.length) return { error: 'Tidak ada menu/hasil untuk dialokasikan' };
  if (!input.servicePoints.length) return { error: 'Pilih minimal satu titik layanan' };

  const points = input.servicePoints;
  const out: DistributionLine[] = [];

  for (const item of input.items) {
    const total = Number(item.qtyPorsi) || 0;
    if (!(total > 0)) continue;
    // Weighted by kapasitas when set; else equal split.
    // Shares are non-negative and sum exactly to total (remainder on last point).
    const weights = points.map((p) => {
      const k = Number(p.kapasitasPorsi);
      return Number.isFinite(k) && k > 0 ? k : 1;
    });
    const weightSum = weights.reduce((s, w) => s + w, 0) || points.length;
    const shares: number[] = new Array(points.length).fill(0);
    let allocated = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const share = Math.max(0, roundQty((total * weights[i]) / weightSum));
      shares[i] = share;
      allocated = roundQty(allocated + share);
    }
    shares[points.length - 1] = Math.max(0, roundQty(total - allocated));
    // If early rounding overshot, peel from earlier points so last stays ≥ 0 and sum = total.
    let sum = shares.reduce((s, n) => roundQty(s + n), 0);
    let drift = roundQty(total - sum);
    if (drift !== 0) {
      for (let i = points.length - 1; i >= 0 && drift !== 0; i--) {
        const next = roundQty(shares[i] + drift);
        if (next >= 0) {
          shares[i] = next;
          drift = 0;
        } else {
          drift = roundQty(drift + shares[i]);
          shares[i] = 0;
        }
      }
    }
    for (let i = 0; i < points.length; i++) {
      const share = shares[i];
      if (!(share > 0)) continue;
      const sp = points[i];
      out.push({
        servicePointId: sp.id,
        servicePointKode: sp.kode,
        servicePointNama: sp.nama,
        menuId: item.menuId,
        menuKode: item.menuKode,
        menuNama: item.menuNama,
        finishedGoodProductId: item.finishedGoodProductId,
        finishedGoodKode: item.finishedGoodKode,
        finishedGoodNama: item.finishedGoodNama,
        qtyPorsi: share,
      });
    }
  }

  if (!out.length) return { error: 'Alokasi menghasilkan 0 baris' };
  return out;
}

/** Source items minus already-consumed non-CANCELLED DST (same source keys). */
export function remainingSourceItems(
  sourceItems: Array<{
    menuId?: string;
    menuKode?: string;
    menuNama?: string;
    finishedGoodProductId?: string;
    finishedGoodKode?: string;
    finishedGoodNama?: string;
    qtyPorsi: number;
  }>,
  existingConsumedLines?: DistributionLine[],
): Array<{
  menuId?: string;
  menuKode?: string;
  menuNama?: string;
  finishedGoodProductId?: string;
  finishedGoodKode?: string;
  finishedGoodNama?: string;
  qtyPorsi: number;
}> | { error: string } {
  if (!sourceItems.length) return { error: 'Sumber alokasi tidak ditemukan' };
  const used = new Map<string, number>();
  for (const l of existingConsumedLines || []) {
    const key = distLineKey(l);
    used.set(key, roundQty((used.get(key) || 0) + (Number(l.qtyPorsi) || 0)));
  }
  const out: typeof sourceItems = [];
  for (const src of sourceItems) {
    const key = distLineKey(src);
    if (key === '|') return { error: 'Baris sumber tidak punya menuId/finishedGoodProductId' };
    const remain = roundQty((Number(src.qtyPorsi) || 0) - (used.get(key) || 0));
    if (remain > 0) {
      out.push({ ...src, qtyPorsi: remain });
      used.delete(key);
    } else {
      used.delete(key);
    }
  }
  // Orphan consumed keys (different source type) are ignored here — assertDistQtyWithinSource
  // still guards on the final lines against the original source.
  if (!out.length) return { error: 'Sumber sudah teralokasi penuh' };
  return out;
}

export function distLineKey(line: {
  menuId?: string;
  finishedGoodProductId?: string;
}): string {
  return `${line.menuId || ''}|${line.finishedGoodProductId || ''}`;
}

/** Remaining porsi vs source — includes non-cancelled DST already consumed. */
export function assertDistQtyWithinSource(input: {
  sourceItems: Array<{ menuId?: string; finishedGoodProductId?: string; qtyPorsi: number }>;
  newLines: DistributionLine[];
  /** Non-CANCELLED lines already allocated (open + completed). */
  existingConsumedLines?: DistributionLine[];
}): string | null {
  if (!input.sourceItems.length) {
    return 'Sumber alokasi tidak ditemukan';
  }
  const availByKey = new Map<string, number>();
  for (const src of input.sourceItems) {
    const key = distLineKey(src);
    if (key === '|') return 'Baris sumber tidak punya menuId/finishedGoodProductId';
    availByKey.set(key, roundQty((availByKey.get(key) || 0) + (Number(src.qtyPorsi) || 0)));
  }

  const used = new Map<string, number>();
  const bump = (lines: DistributionLine[]) => {
    for (const l of lines) {
      const key = distLineKey(l);
      used.set(key, roundQty((used.get(key) || 0) + (Number(l.qtyPorsi) || 0)));
    }
  };
  bump(input.existingConsumedLines || []);
  bump(input.newLines);

  for (const [key, take] of used) {
    if (!availByKey.has(key)) {
      return `Baris alokasi tidak ada di sumber (${key || 'kosong'})`;
    }
    const avail = availByKey.get(key) || 0;
    if (take > avail + 0.0001) {
      return `Alokasi melebihi sumber untuk ${key}: ${take} > ${avail}`;
    }
  }
  return null;
}
