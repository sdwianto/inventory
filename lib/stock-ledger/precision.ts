// Presisi buku stok: qty disimpan 4 desimal (satuan dasar), harga satuan 4 desimal, nilai uang 2 desimal.
// Semua pembanding qty memakai toleransi STOCK_QTY_EPS agar float dust (0.0999…) tidak memblokir posting.

export const STOCK_QTY_DP = 4;
export const STOCK_UNIT_COST_DP = 4;
export const STOCK_MONEY_DP = 2;
export const STOCK_QTY_EPS = 1e-6;

function roundTo(n: number, dp: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** dp;
  const r = Math.round((Math.abs(v) + Number.EPSILON) * f) / f;
  const signed = v < 0 ? -r : r;
  return Object.is(signed, -0) ? 0 : signed;
}

export function roundStockQty(n: number | string | null | undefined): number {
  return roundTo(parseFloat(String(n ?? 0)) || 0, STOCK_QTY_DP);
}

/** Pembulatan qty simetris (default 4 dp) — satu-satunya pembulat qty di aplikasi. */
export function roundQty(n: number | string | null | undefined, dp: number = STOCK_QTY_DP): number {
  return roundTo(parseFloat(String(n ?? 0)) || 0, dp);
}

export function roundUnitCost(n: number | string | null | undefined): number {
  return roundTo(parseFloat(String(n ?? 0)) || 0, STOCK_UNIT_COST_DP);
}

export function roundMoney(n: number | string | null | undefined): number {
  return roundTo(parseFloat(String(n ?? 0)) || 0, STOCK_MONEY_DP);
}

/** a < b secara bermakna (bukan karena float dust). */
export function qtyLt(a: number, b: number): boolean {
  return roundStockQty(a) < roundStockQty(b) - STOCK_QTY_EPS;
}

export function qtyGt(a: number, b: number): boolean {
  return qtyLt(b, a);
}

export function qtyEq(a: number, b: number): boolean {
  return Math.abs(roundStockQty(a) - roundStockQty(b)) <= STOCK_QTY_EPS;
}

export function isZeroQty(a: number): boolean {
  return qtyEq(a, 0);
}
