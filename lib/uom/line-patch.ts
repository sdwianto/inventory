import type { ProductUom } from '@/lib/uom/types';

export function lineUomFactor(f?: number): number {
  const n = parseFloat(String(f ?? 1));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function uomFactorOf(uom: Pick<ProductUom, 'isBase' | 'factorToBase'>): number {
  return uom.isBase ? 1 : lineUomFactor(uom.factorToBase);
}

/** Qty baris → qty satuan dasar. */
export function qtyBaseFromLine(qty: unknown, factorToBase?: number): number {
  const oldQty = parseFloat(String(qty)) || 0;
  return oldQty * lineUomFactor(factorToBase);
}

/** Konversi qty antar satuan — jumlah base tetap. */
export function convertQtyBetweenUoms(
  qty: unknown,
  oldFactorToBase: number | undefined,
  nextUom: Pick<ProductUom, 'isBase' | 'factorToBase'>,
): number {
  const qtyBase = qtyBaseFromLine(qty, oldFactorToBase);
  const newFactor = uomFactorOf(nextUom);
  return Math.round((qtyBase / newFactor) * 1000) / 1000;
}

/** Ganti satuan — hanya qty (GRN, penyesuaian, transfer, dll.). */
export function patchQtyLineOnUomChange(
  line: { qty?: unknown; factorToBase?: number },
  nextUom: ProductUom,
) {
  return {
    uomId: nextUom.id,
    satuan: nextUom.satuan,
    factorToBase: nextUom.factorToBase,
    qty: convertQtyBetweenUoms(line.qty, line.factorToBase, nextUom),
  };
}

/** Ganti satuan — qty + harga beli per kemasan; total baris tetap. */
export function patchPurchaseLineOnUomChange(
  line: { qty?: unknown; harga?: unknown; factorToBase?: number },
  nextUom: ProductUom,
) {
  const oldFactor = lineUomFactor(line.factorToBase);
  const newFactor = uomFactorOf(nextUom);
  const qtyBase = qtyBaseFromLine(line.qty, line.factorToBase);
  const oldHarga = parseInt(String(line.harga || 0), 10) || 0;
  const hargaBase = Math.round(oldHarga / oldFactor);
  const qty = Math.round((qtyBase / newFactor) * 1000) / 1000;
  const harga = hargaBase * newFactor;

  return {
    uomId: nextUom.id,
    satuan: nextUom.satuan,
    factorToBase: nextUom.factorToBase,
    qty,
    harga,
  };
}

/** Ganti satuan baris PO inventory — qty + estimasi harga per kemasan. */
export function patchPoEstimasiLineOnUomChange(
  line: { qty?: unknown; estimasiHarga?: unknown; factorToBase?: number },
  nextUom: ProductUom,
) {
  const patched = patchPurchaseLineOnUomChange(
    { qty: line.qty, harga: line.estimasiHarga, factorToBase: line.factorToBase },
    nextUom,
  );
  return {
    uomId: patched.uomId,
    satuan: patched.satuan,
    factorToBase: patched.factorToBase,
    qty: patched.qty,
    estimasiHarga: patched.harga > 0 ? String(patched.harga) : '',
  };
}
