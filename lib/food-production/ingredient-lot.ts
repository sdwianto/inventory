/**
 * W2-5 — Ingredient lots stamped on GRN POST (foundation for W2-6 Issue FEFO).
 */

export const INGREDIENT_LOTS_COLLECTION = 'ingredient_lots';

/** Default shelf life when GRN line / product has no expiry (days). */
export const DEFAULT_INGREDIENT_SHELF_DAYS = 30;

export type IngredientLotStatus = 'ACTIVE' | 'EXPIRED' | 'CONSUMED';

export interface IngredientLotDoc {
  id: string;
  tenantId: string;
  lotNo: string;
  grnId: string;
  noGRN?: string;
  productId: string;
  productKode?: string;
  productNama?: string;
  warehouseKode: string;
  receivedAt: string;
  expiryDate: string;
  qty: number;
  qtyRemaining: number;
  satuan?: string;
  status: IngredientLotStatus;
  lineIndex?: number;
  lastConsumedBy?: {
    issueId?: string;
    noDokumen?: string;
    at?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

export function buildIngredientLotNo(input: {
  noGRN?: string;
  productKode?: string;
  lineIndex: number;
  receivedAt: string;
}): string {
  const day = String(input.receivedAt || '').replace(/-/g, '').slice(0, 8) || '00000000';
  const grn = String(input.noGRN || 'GRN').split('-').pop() || 'X';
  const kode = String(input.productKode || 'P').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'P';
  return `L-${grn}-${kode}-${day}-${input.lineIndex + 1}`.toUpperCase();
}

export function defaultIngredientExpiryDate(
  receivedAt: string | Date,
  shelfDays = DEFAULT_INGREDIENT_SHELF_DAYS,
): string {
  const raw = typeof receivedAt === 'string'
    ? receivedAt.trim()
    : receivedAt.toISOString().slice(0, 10);
  const base = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00.000Z`)
    : new Date();
  base.setUTCDate(base.getUTCDate() + Math.max(0, shelfDays));
  return base.toISOString().slice(0, 10);
}

export function effectiveIngredientQtyRemaining(
  b: Pick<IngredientLotDoc, 'qty' | 'qtyRemaining' | 'status'>,
): number {
  if (b.qtyRemaining != null && Number.isFinite(Number(b.qtyRemaining))) {
    return Math.max(0, Number(b.qtyRemaining));
  }
  if (b.status === 'CONSUMED') return 0;
  const q = Number(b.qty);
  return Number.isFinite(q) && q > 0 ? q : 0;
}

export function isIngredientExpired(expiryDate: string, asOf = new Date()): boolean {
  const exp = String(expiryDate || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return false;
  return exp < asOf.toISOString().slice(0, 10);
}
