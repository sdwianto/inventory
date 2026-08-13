import { lineUomFactor, uomFactorOf } from '@/lib/uom/line-patch';
import type { ProductUom } from '@/lib/uom/types';

export function pickDefaultUom(uoms: ProductUom[]): ProductUom | null {
  return uoms.find((u) => u.isBase) || uoms[0] || null;
}

export function lineUomKey(stokId: string, uomId?: string): string {
  return `${stokId}::${uomId || ''}`;
}

export function qtyInUom(qtyBase: number, uom: ProductUom | null | undefined): number {
  const base = parseFloat(String(qtyBase)) || 0;
  if (!uom || uom.isBase || uom.factorToBase <= 0) return base;
  return Math.round((base / uom.factorToBase) * 1000) / 1000;
}

export function findUomByIdOrSatuan(
  uoms: ProductUom[],
  uomId?: string | null,
  satuan?: string | null,
): ProductUom | null {
  const id = String(uomId || '').trim();
  if (id) {
    const byId = uoms.find((u) => u.id === id);
    if (byId) return byId;
  }
  const sat = String(satuan || '').trim().toUpperCase();
  if (sat) {
    const bySat = uoms.find((u) => u.satuan === sat);
    if (bySat) return bySat;
  }
  return null;
}

/**
 * qtyBase harus = qtyOrdered × faktor satuan kirim.
 * Webhook/sales sering kirim qtyBase = qtyOrdered (salah) → Terima Barang jadi 2,7 KG dari 27 KG.
 */
export function reconcileLineQtyBase(opts: {
  qtyOrdered: number;
  orderedFactor: number;
  qtyBaseHint?: unknown;
}): number {
  const qtyOrdered = Number.isFinite(opts.qtyOrdered) ? opts.qtyOrdered : 0;
  const factor = opts.orderedFactor > 0 ? opts.orderedFactor : 1;
  const derived = qtyOrdered * factor;
  const raw = parseFloat(String(opts.qtyBaseHint ?? ''));
  if (!Number.isFinite(raw) || raw < 0) return derived;
  const tol = Math.max(0.001, Math.abs(derived) * 0.001);
  if (Math.abs(raw - derived) <= tol) return raw;
  return derived;
}

/**
 * Inisialisasi baris Terima Barang.
 * Prioritas tampilan: satuan label "kirim" (DO) → uomId → default produk.
 * qtyOrdered selalu dalam satuan kirim; qtyBase yang inkonsisten diabaikan.
 */
export function resolveGrnReceiveLineUom(input: {
  uoms: ProductUom[];
  uomId?: string | null;
  satuan?: string | null;
  qtyOrdered?: unknown;
  qtyBase?: unknown;
  factorToBase?: unknown;
}): {
  uom: ProductUom | null;
  qty: number;
  qtyBase: number;
  factorToBase: number;
} {
  const uoms = input.uoms || [];
  const byId = String(input.uomId || '').trim()
    ? uoms.find((u) => u.id === String(input.uomId).trim())
    : undefined;
  const sat = String(input.satuan || '').trim().toUpperCase();
  const bySat = sat ? uoms.find((u) => u.satuan === sat) : undefined;
  /** Satuan yang menjelaskan qtyOrdered / label "kirim". */
  const orderedUom = bySat || byId || null;
  /** Prefer satuan kirim agar dropdown = label DO (bukan ONS default dari uomId salah). */
  const displayUom = bySat || byId || pickDefaultUom(uoms);

  const qtyOrdered = parseFloat(String(input.qtyOrdered ?? 0)) || 0;
  const orderedFactor = orderedUom
    ? uomFactorOf(orderedUom)
    : lineUomFactor(input.factorToBase as number | undefined);
  const qtyBase = reconcileLineQtyBase({
    qtyOrdered,
    orderedFactor,
    qtyBaseHint: input.qtyBase,
  });

  const factorToBase = displayUom ? uomFactorOf(displayUom) : 1;
  /** Hindari drift float: jika satuan tampilan = satuan kirim, qty = qtyOrdered. */
  if (displayUom && orderedUom && displayUom.id === orderedUom.id) {
    return { uom: displayUom, qty: qtyOrdered, qtyBase, factorToBase };
  }
  const qty = qtyInUom(qtyBase, displayUom);
  return { uom: displayUom, qty, qtyBase, factorToBase };
}
