/**
 * Production Batch + Expiry — ADR-001 Phase 4 · W2-1 FEFO consume.
 * Batch stamped on Result COMPLETE; qtyRemaining decremented on Release FEFO.
 */

export const PRODUCTION_BATCHES_COLLECTION = 'production_batches';

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
