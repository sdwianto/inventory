/**
 * Distribution Order / Packing list — ADR-001 Phase 5 / Sprint 19.
 * Packing dari HSL (actual) ke titik layanan.
 * DRAFT = disiapkan; PROCESSING = dikirim; COMPLETED = selesai (semua titik settled).
 * Retur dicatat per titik (qtyDikembalikan), bukan status dokumen global.
 * Tanpa mutasi stok (MBG: porsi langsung distribusi).
 */

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import { FP_DEFAULT_TRANSITIONS } from '@/lib/food-production/document';
import { roundQty } from '@/lib/food-production/material-requirement';

export const DISTRIBUTION_ORDERS_COLLECTION = 'distribution_orders';

/** Satu set makanan per porsi (MBG) — bukan per resep. */
export const FOOD_TRAY_ID = 'FOOD_TRAY';
export const FOOD_TRAY_LABEL = 'Food Tray';

export type DistributionSourceType = 'PLAN' | 'RESULT';
export type DistributionStatus = FpDocStatus;

export interface DistributionLine {
  servicePointId: string;
  servicePointKode?: string;
  servicePointNama?: string;
  /** Kapasitas titik layanan saat packing dibuat. */
  kapasitasPorsi?: number;
  menuId?: string;
  menuKode?: string;
  menuNama?: string;
  /** Identitas baris MBG bila rencana langsung resep (tanpa menu / FG). */
  recipeId?: string;
  recipeKode?: string;
  recipeNama?: string;
  finishedGoodProductId?: string;
  finishedGoodKode?: string;
  finishedGoodNama?: string;
  /** Alokasi rencana (saat disiapkan). */
  qtyPorsi: number;
  /** Actual dikirim ke titik. */
  qtyDikirim?: number;
  /** Actual diterima di titik. */
  qtyDiterima?: number;
  /** Actual dikembalikan dari titik (bukan status dokumen). */
  qtyDikembalikan?: number;
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
    qtyDikirimTotal?: number;
    qtyDiterimaTotal?: number;
    qtyDikembalikanTotal?: number;
    servicePointCount: number;
    settledCount?: number;
  };
  catatan?: string;
  lastStatusPhotoUrls?: string[];
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

/**
 * Disiapkan → Dikirim → Selesai.
 * CANCELLED hanya untuk batalkan packing (belum/selama disiapkan), bukan retur per titik.
 */
export const DIST_STATUS_TRANSITIONS: Record<string, string[]> = {
  ...FP_DEFAULT_TRANSITIONS,
  DRAFT: ['PROCESSING', 'CANCELLED'],
  SUBMITTED: ['PROCESSING', 'CANCELLED'],
  APPROVED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED'],
  COMPLETED: [],
};

export const DIST_STATUS_LABELS: Record<DistributionStatus, string> = {
  DRAFT: 'Disiapkan',
  SUBMITTED: 'Disiapkan',
  APPROVED: 'Disiapkan',
  PROCESSING: 'Dikirim',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};

export const DIST_UI_STATUS_NEXT: Partial<Record<DistributionStatus, DistributionStatus>> = {
  DRAFT: 'PROCESSING',
  SUBMITTED: 'PROCESSING',
  APPROVED: 'PROCESSING',
  PROCESSING: 'COMPLETED',
};

export const DIST_UI_STATUS_NEXT_LABEL: Partial<Record<DistributionStatus, string>> = {
  DRAFT: 'Dikirim',
  SUBMITTED: 'Dikirim',
  APPROVED: 'Dikirim',
  PROCESSING: 'Selesaikan titik',
};

export function isDistEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED';
}

/** Titik sudah diselesaikan bila diterima+kembali menutup qty dikirim. */
export function isDistLineSettled(line: DistributionLine): boolean {
  if (line.qtyDiterima == null && line.qtyDikembalikan == null) return false;
  const sent = roundQty(Number(line.qtyDikirim ?? line.qtyPorsi) || 0);
  const recv = roundQty(Number(line.qtyDiterima) || 0);
  const ret = roundQty(Number(line.qtyDikembalikan) || 0);
  return Math.abs(roundQty(recv + ret) - sent) < 0.0001;
}

export function allDistLinesSettled(lines: DistributionLine[]): boolean {
  return (lines || []).length > 0 && (lines || []).every(isDistLineSettled);
}

export function summarizeDistLines(lines: DistributionLine[]) {
  const list = lines || [];
  const points = new Set(list.map((l) => l.servicePointId).filter(Boolean));
  return {
    lineCount: list.length,
    qtyPorsiTotal: roundQty(list.reduce((s, l) => s + (Number(l.qtyPorsi) || 0), 0)),
    qtyDikirimTotal: roundQty(list.reduce((s, l) => s + (Number(l.qtyDikirim) || 0), 0)),
    qtyDiterimaTotal: roundQty(list.reduce((s, l) => s + (Number(l.qtyDiterima) || 0), 0)),
    qtyDikembalikanTotal: roundQty(list.reduce((s, l) => s + (Number(l.qtyDikembalikan) || 0), 0)),
    servicePointCount: points.size,
    settledCount: list.filter(isDistLineSettled).length,
  };
}

function optionalNonNegQty(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return roundQty(n);
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
    const recipeId = row.recipeId != null ? String(row.recipeId).trim() || undefined : undefined;
    const fgId = row.finishedGoodProductId != null
      ? String(row.finishedGoodProductId).trim() || undefined
      : undefined;
    const itemKey = distLineKey({ menuId, finishedGoodProductId: fgId, recipeId });
    if (itemKey === '|') {
      return { error: `Baris ${i + 1}: wajib menuId, finishedGoodProductId, atau recipeId` };
    }
    const key = `${servicePointId}|${itemKey}`;
    if (seen.has(key)) return { error: `Baris ${i + 1}: duplikat titik × menu/FG/resep` };
    seen.add(key);
    const kapasitas = optionalNonNegQty(row.kapasitasPorsi);
    const qtyDikirim = optionalNonNegQty(row.qtyDikirim);
    const qtyDiterima = optionalNonNegQty(row.qtyDiterima);
    const qtyDikembalikan = optionalNonNegQty(row.qtyDikembalikan);
    out.push({
      servicePointId,
      servicePointKode: row.servicePointKode != null ? String(row.servicePointKode) : undefined,
      servicePointNama: row.servicePointNama != null ? String(row.servicePointNama) : undefined,
      kapasitasPorsi: kapasitas,
      menuId,
      menuKode: row.menuKode != null ? String(row.menuKode) : undefined,
      menuNama: row.menuNama != null ? String(row.menuNama) : undefined,
      recipeId,
      recipeKode: row.recipeKode != null ? String(row.recipeKode) : undefined,
      recipeNama: row.recipeNama != null ? String(row.recipeNama) : undefined,
      finishedGoodProductId: fgId,
      finishedGoodKode: row.finishedGoodKode != null ? String(row.finishedGoodKode) : undefined,
      finishedGoodNama: row.finishedGoodNama != null ? String(row.finishedGoodNama) : undefined,
      qtyPorsi: roundQty(qtyPorsi),
      ...(qtyDikirim != null ? { qtyDikirim } : {}),
      ...(qtyDiterima != null ? { qtyDiterima } : {}),
      ...(qtyDikembalikan != null ? { qtyDikembalikan } : {}),
      notes: row.notes != null ? String(row.notes) : undefined,
    });
  }
  return out;
}

/** Apply qty dikirim per line (status → Dikirim). */
export function applyDistLineActuals(
  lines: DistributionLine[],
  toStatus: string,
  actuals?: Array<{
    servicePointId: string;
    menuId?: string;
    recipeId?: string;
    finishedGoodProductId?: string;
    qty: number;
    notes?: string;
  }>,
): DistributionLine[] | { error: string } {
  if (toStatus === 'COMPLETED') {
    return { error: 'Gunakan settle per titik (diterima + dikembalikan) untuk menyelesaikan distribusi' };
  }
  const byKey = new Map<string, { qty: number; notes?: string }>();
  for (const a of actuals || []) {
    const sp = String(a.servicePointId || '').trim();
    if (!sp) continue;
    const qty = Number(a.qty);
    if (!Number.isFinite(qty) || qty < 0) {
      return { error: 'Qty actual per titik harus ≥ 0' };
    }
    const notes = a.notes != null ? String(a.notes).trim() : undefined;
    byKey.set(`${sp}|${distLineKey(a)}`, {
      qty: roundQty(qty),
      notes: a.notes != null ? (notes || '') : undefined,
    });
  }

  return lines.map((line) => {
    const key = `${line.servicePointId}|${distLineKey(line)}`;
    const actual = byKey.get(key);
    const next = { ...line };
    if (toStatus === 'PROCESSING') {
      next.qtyDikirim = actual ? actual.qty : (line.qtyDikirim ?? line.qtyPorsi);
      if (actual?.notes !== undefined) next.notes = actual.notes.trim() || undefined;
    }
    return next;
  });
}

/**
 * Selesaikan per titik: isi qtyDiterima + qtyDikembalikan (jumlah harus = qtyDikirim).
 */
export function applyDistSettleLines(
  lines: DistributionLine[],
  settles?: Array<{
    servicePointId: string;
    menuId?: string;
    recipeId?: string;
    finishedGoodProductId?: string;
    qtyDiterima: number;
    qtyDikembalikan: number;
    notes?: string;
  }>,
): DistributionLine[] | { error: string } {
  const byKey = new Map<string, {
    qtyDiterima: number;
    qtyDikembalikan: number;
    notes?: string;
  }>();
  for (const a of settles || []) {
    const sp = String(a.servicePointId || '').trim();
    if (!sp) continue;
    const qtyDiterima = Number(a.qtyDiterima);
    const qtyDikembalikan = Number(a.qtyDikembalikan);
    if (!Number.isFinite(qtyDiterima) || qtyDiterima < 0) {
      return { error: 'Qty diterima per titik harus ≥ 0' };
    }
    if (!Number.isFinite(qtyDikembalikan) || qtyDikembalikan < 0) {
      return { error: 'Qty dikembalikan per titik harus ≥ 0' };
    }
    const notes = a.notes != null ? String(a.notes).trim() : undefined;
    byKey.set(`${sp}|${distLineKey(a)}`, {
      qtyDiterima: roundQty(qtyDiterima),
      qtyDikembalikan: roundQty(qtyDikembalikan),
      notes: a.notes != null ? (notes || '') : undefined,
    });
  }

  const out: DistributionLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = `${line.servicePointId}|${distLineKey(line)}`;
    const settle = byKey.get(key);
    const next = { ...line };
    if (next.qtyDikirim == null) next.qtyDikirim = line.qtyPorsi;
    const sent = roundQty(Number(next.qtyDikirim) || 0);

    if (settle) {
      next.qtyDiterima = settle.qtyDiterima;
      next.qtyDikembalikan = settle.qtyDikembalikan;
      if (settle.notes !== undefined) next.notes = settle.notes.trim() || undefined;
    } else if (next.qtyDiterima == null && next.qtyDikembalikan == null) {
      // default: semua diterima, tidak ada retur
      next.qtyDiterima = sent;
      next.qtyDikembalikan = 0;
    }

    const recv = roundQty(Number(next.qtyDiterima) || 0);
    const ret = roundQty(Number(next.qtyDikembalikan) || 0);
    if (Math.abs(roundQty(recv + ret) - sent) > 0.0001) {
      const nama = line.servicePointNama || line.servicePointKode || line.servicePointId;
      return {
        error: `Titik "${nama}": diterima (${recv}) + dikembalikan (${ret}) harus = dikirim (${sent})`,
      };
    }
    out.push(next);
  }
  return out;
}

/** Movement qty for a status step (sum of relevant actual field). */
export function movementQtyForStatus(lines: DistributionLine[], toStatus: string): number {
  if (toStatus === 'PROCESSING') {
    return roundQty(lines.reduce((s, l) => s + (Number(l.qtyDikirim ?? l.qtyPorsi) || 0), 0));
  }
  if (toStatus === 'COMPLETED') {
    return roundQty(lines.reduce((s, l) => s + (Number(l.qtyDiterima) || 0) + (Number(l.qtyDikembalikan) || 0), 0));
  }
  return roundQty(lines.reduce((s, l) => s + (Number(l.qtyPorsi) || 0), 0));
}

/**
 * Gabung baris resep/menu → 1 item Food Tray.
 * Qty = max porsi baris (1 tray = 1 set makanan, bukan penjumlahan tiap resep).
 */
export function collapseSourceToFoodTray(
  items: Array<{ qtyPorsi: number }>,
): Array<{
  recipeId: string;
  recipeNama: string;
  menuNama: string;
  finishedGoodNama: string;
  qtyPorsi: number;
}> | { error: string } {
  const qtys = (items || []).map((i) => Number(i.qtyPorsi) || 0).filter((q) => q > 0);
  if (!qtys.length) return { error: 'Sumber alokasi tidak ditemukan' };
  return [{
    recipeId: FOOD_TRAY_ID,
    recipeNama: FOOD_TRAY_LABEL,
    menuNama: FOOD_TRAY_LABEL,
    finishedGoodNama: FOOD_TRAY_LABEL,
    qtyPorsi: roundQty(Math.max(...qtys)),
  }];
}

/** Build draft packing lines: each plan/result line × each service point (equal split). */
export function allocatePorsiAcrossPoints(input: {
  items: Array<{
    menuId?: string;
    menuKode?: string;
    menuNama?: string;
    recipeId?: string;
    recipeKode?: string;
    recipeNama?: string;
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
        kapasitasPorsi: Number.isFinite(Number(sp.kapasitasPorsi)) && Number(sp.kapasitasPorsi) > 0
          ? Number(sp.kapasitasPorsi)
          : undefined,
        menuId: item.menuId,
        menuKode: item.menuKode,
        menuNama: item.menuNama || item.recipeNama || item.finishedGoodNama,
        recipeId: item.recipeId,
        recipeKode: item.recipeKode,
        recipeNama: item.recipeNama,
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
    recipeId?: string;
    recipeKode?: string;
    recipeNama?: string;
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
  recipeId?: string;
  recipeKode?: string;
  recipeNama?: string;
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
    if (key === '|') {
      return { error: 'Baris sumber tidak punya menuId/finishedGoodProductId/recipeId' };
    }
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

/**
 * Identitas item alokasi.
 * Prefer menu|FG (legacy); fallback recipe:… untuk MBG resep-langsung tanpa menu/FG.
 */
export function distLineKey(line: {
  menuId?: string;
  finishedGoodProductId?: string;
  recipeId?: string;
}): string {
  const menuId = String(line.menuId || '').trim();
  const fgId = String(line.finishedGoodProductId || '').trim();
  const recipeId = String(line.recipeId || '').trim();
  if (menuId || fgId) return `${menuId}|${fgId}`;
  if (recipeId) return `recipe:${recipeId}`;
  return '|';
}

/** Remaining porsi vs source — includes non-cancelled DST already consumed. */
export function assertDistQtyWithinSource(input: {
  sourceItems: Array<{
    menuId?: string;
    finishedGoodProductId?: string;
    recipeId?: string;
    qtyPorsi: number;
  }>;
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
    if (key === '|') return 'Baris sumber tidak punya menuId/finishedGoodProductId/recipeId';
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
