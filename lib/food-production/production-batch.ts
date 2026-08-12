/**
 * Production Batch + Expiry — ADR-001 Phase 4 · W2-1 FEFO consume.
 * Batch stamped on Result COMPLETE; qtyRemaining decremented on Release FEFO.
 *
 * ADR-004: batch juga menjadi unit disposisi food safety (`foodSafetyStatus`),
 * terpisah penuh dari lifecycle inventory (`status`).
 */

import { appendDocHistory, type DocHistoryEntry } from '@/lib/food-production/document';

export const PRODUCTION_BATCHES_COLLECTION = 'production_batches';

/** ADR-004 — disposisi keamanan pangan. Bukan lifecycle inventory. */
export type FoodSafetyStatus = 'PENDING' | 'PASS' | 'HOLD' | 'RELEASED';

/** Dari mana keputusan disposisi berasal — wajib demi auditability. */
export type FoodSafetySourceType =
  | 'HACCP'
  | 'QC'
  | 'TEMPERATURE'
  | 'KA_FOLLOW_UP'
  | 'MANUAL';

export interface FoodSafetyHistoryEntry extends DocHistoryEntry {
  sourceType: FoodSafetySourceType;
  sourceId?: string;
}

export const FOOD_SAFETY_STATUS_LABELS: Record<FoodSafetyStatus, string> = {
  PENDING: 'Belum diperiksa',
  PASS: 'Lolos pemeriksaan',
  HOLD: 'Ditahan',
  RELEASED: 'Dilepas setelah verifikasi',
};

/**
 * RELEASED → HOLD sengaja diizinkan: temuan baru (mis. keluhan atau hasil lab
 * yang terlambat) harus bisa menahan ulang batch yang sudah dilepas.
 * HOLD → PASS sengaja dilarang: pelepasan wajib lewat RELEASED agar terekam.
 */
export const FOOD_SAFETY_TRANSITIONS: Record<FoodSafetyStatus, FoodSafetyStatus[]> = {
  PENDING: ['PASS', 'HOLD'],
  PASS: ['HOLD'],
  HOLD: ['RELEASED'],
  RELEASED: ['HOLD'],
};

export const DEFAULT_FOOD_SAFETY_STATUS: FoodSafetyStatus = 'PENDING';

/** Baris lama tanpa field ini diperlakukan sebagai PENDING. */
export function effectiveFoodSafetyStatus(
  b: Pick<ProductionBatchDoc, 'foodSafetyStatus'> | null | undefined,
): FoodSafetyStatus {
  const raw = String(b?.foodSafetyStatus || '').toUpperCase();
  if (raw === 'PENDING' || raw === 'PASS' || raw === 'HOLD' || raw === 'RELEASED') {
    return raw;
  }
  return DEFAULT_FOOD_SAFETY_STATUS;
}

export function normalizeFoodSafetyStatus(raw: unknown): FoodSafetyStatus | { error: string } {
  const v = String(raw || '').toUpperCase();
  if (v === 'PENDING' || v === 'PASS' || v === 'HOLD' || v === 'RELEASED') return v;
  return { error: 'foodSafetyStatus wajib PENDING | PASS | HOLD | RELEASED' };
}

/**
 * Filter Mongo untuk mencocokkan disposisi yang sama, dengan baris lama
 * (field belum ada) dihitung sebagai PENDING — `null` pada $in juga cocok
 * untuk field yang tidak ada. Dipakai agar qty batch tertahan tidak pernah
 * melebur ke batch berdisposisi lain saat relokasi antar-gudang.
 */
export function foodSafetyStatusMatch(
  status: FoodSafetyStatus,
): FoodSafetyStatus | { $in: Array<FoodSafetyStatus | null> } {
  return status === DEFAULT_FOOD_SAFETY_STATUS ? { $in: [status, null] } : status;
}

/** Hanya HOLD yang memblokir pengeluaran (ADR-004 §9). */
export function isFoodSafetyBlocked(
  b: Pick<ProductionBatchDoc, 'foodSafetyStatus'> | null | undefined,
): boolean {
  return effectiveFoodSafetyStatus(b) === 'HOLD';
}

export type FoodSafetyTransitionInput = {
  to: FoodSafetyStatus;
  sourceType: FoodSafetySourceType;
  sourceId?: string;
  /** Wajib — gate Auditability menuntut alasan tercatat pada setiap HOLD/RELEASE. */
  reason: string;
  at?: Date;
  userId?: string;
  userName?: string;
};

export type FoodSafetyTransitionResult = {
  foodSafetyStatus: FoodSafetyStatus;
  foodSafetyHistory: FoodSafetyHistoryEntry[];
};

/**
 * Pure — hitung status + history baru, atau tolak transisi.
 * Alasan disimpan pada `note` agar sebentuk dengan history dokumen FP lain.
 */
export function applyFoodSafetyTransition(
  batch: Pick<ProductionBatchDoc, 'foodSafetyStatus' | 'foodSafetyHistory'> | null | undefined,
  input: FoodSafetyTransitionInput,
): FoodSafetyTransitionResult | { error: string } {
  const from = effectiveFoodSafetyStatus(batch);
  const to = input.to;
  const reason = String(input.reason || '').trim();
  if (!reason) return { error: 'Alasan wajib diisi untuk perubahan status food safety' };
  // ADR-004 P0H / Recovery gate — RELEASE hanya via corrective action VERIFIED (KA_FOLLOW_UP).
  if (to === 'RELEASED') {
    if (input.sourceType !== 'KA_FOLLOW_UP') {
      return { error: 'Pelepasan food safety (RELEASED) hanya melalui follow-up KA yang diverifikasi' };
    }
    if (!String(input.sourceId || '').trim()) {
      return { error: 'sourceId wajib untuk pelepasan food safety (RELEASED)' };
    }
  }

  if (from !== to) {
    const allowed = FOOD_SAFETY_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
      return {
        error: `Status food safety tidak boleh dari ${FOOD_SAFETY_STATUS_LABELS[from]} ke ${FOOD_SAFETY_STATUS_LABELS[to]}`,
      };
    }
  }

  const entry: FoodSafetyHistoryEntry = {
    at: input.at ?? new Date(),
    fromStatus: from,
    toStatus: to,
    userId: input.userId,
    userName: input.userName,
    note: reason,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
  };

  return {
    foodSafetyStatus: to,
    foodSafetyHistory: appendDocHistory(batch?.foodSafetyHistory, entry),
  };
}

export interface ProductionBatchDoc {
  id: string;
  tenantId: string;
  batchNo: string;
  productionResultId: string;
  productionResultNo: string;
  productionPlanId: string;
  productionPlanNo?: string;
  kitchenId: string;
  kitchenNama?: string;
  warehouseKode: string;
  producedAt: string;
  expiryDate: string;
  finishedGoodProductId?: string;
  finishedGoodNama?: string;
  qty: number;
  /** Remaining after FEFO consume; defaults to qty for legacy rows. */
  qtyRemaining?: number;
  satuan?: string;
  status: 'ACTIVE' | 'EXPIRED' | 'CONSUMED';
  /** ADR-004 — disposisi food safety. Opsional: baris lama dibaca sebagai PENDING. */
  foodSafetyStatus?: FoodSafetyStatus;
  foodSafetyHistory?: FoodSafetyHistoryEntry[];
  lastConsumedBy?: {
    releaseId?: string;
    noRelease?: string;
    distributionId?: string;
    noDokumen?: string;
    at?: Date;
  };
  lastRestoredBy?: {
    distributionId?: string;
    noDokumen?: string;
    at?: Date;
  };
  lastCycleCountBy?: {
    noDokumen?: string;
    delta?: number;
    at?: Date;
  };
  /** W2-12: set when batch cloned on partial transfer relocate. */
  relocatedFromBatchId?: string;
  /** W2-12: last TR/XFR that relocated this batch (or its remainder). */
  lastRelocatedBy?: {
    transferId?: string;
    xferId?: string;
    noTransaksi?: string;
    fromWarehouseKode?: string;
    toWarehouseKode?: string;
    at?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

/** Legacy rows without qtyRemaining: ACTIVE/EXPIRED → qty, CONSUMED → 0. */
export function effectiveQtyRemaining(b: Pick<ProductionBatchDoc, 'qty' | 'qtyRemaining' | 'status'>): number {
  if (b.qtyRemaining != null && Number.isFinite(Number(b.qtyRemaining))) {
    return Math.max(0, Number(b.qtyRemaining));
  }
  if (b.status === 'CONSUMED') return 0;
  const q = Number(b.qty);
  return Number.isFinite(q) && q > 0 ? q : 0;
}

export function buildBatchNo(input: {
  tanggal: string;
  resultNo: string;
  kitchenKode?: string;
}): string {
  const day = String(input.tanggal || '').replace(/-/g, '').slice(0, 8) || '00000000';
  const suffix = String(input.resultNo || 'HSL').split('-').pop() || 'X';
  const kitchen = input.kitchenKode ? `${input.kitchenKode}-` : '';
  return `B-${kitchen}${day}-${suffix}`.toUpperCase();
}

/** Default shelf life for cooked FG when UI doesn't set expiry (days). */
export const DEFAULT_FG_SHELF_DAYS = 3;

export function defaultExpiryDate(producedAt: string, shelfDays = DEFAULT_FG_SHELF_DAYS): string {
  const raw = String(producedAt || '').trim();
  const base = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00.000Z`)
    : new Date();
  base.setUTCDate(base.getUTCDate() + Math.max(0, shelfDays));
  return base.toISOString().slice(0, 10);
}

export function isExpired(expiryDate: string, asOf = new Date()): boolean {
  const exp = String(expiryDate || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return false;
  const asOfIso = asOf.toISOString().slice(0, 10);
  return exp < asOfIso;
}

export function daysUntilExpiry(expiryDate: string, asOf = new Date()): number | null {
  const exp = String(expiryDate || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return null;
  const a = new Date(`${asOf.toISOString().slice(0, 10)}T12:00:00.000Z`);
  const b = new Date(`${exp}T12:00:00.000Z`);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
