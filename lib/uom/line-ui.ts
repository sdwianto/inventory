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
 * Inisialisasi baris Terima Barang: qty tampilan = qtyBase ÷ faktor satuan aktif.
 * qtyOrdered selalu diinterpretasikan dalam satuan baris (uomId/satuan GRN), bukan default produk.
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
  const displayUom = byId || bySat || pickDefaultUom(uoms);

  const qtyOrdered = parseFloat(String(input.qtyOrdered ?? 0)) || 0;
  const rawBase = parseFloat(String(input.qtyBase ?? ''));
  let qtyBase = Number.isFinite(rawBase) && rawBase >= 0 ? rawBase : NaN;
  if (!Number.isFinite(qtyBase)) {
    if (orderedUom) {
      qtyBase = qtyOrdered * uomFactorOf(orderedUom);
    } else {
      const f = lineUomFactor(input.factorToBase as number | undefined);
      qtyBase = qtyOrdered * f;
    }
  }

  const factorToBase = displayUom ? uomFactorOf(displayUom) : 1;
  const qty = qtyInUom(qtyBase, displayUom);
  return { uom: displayUom, qty, qtyBase, factorToBase };
}
