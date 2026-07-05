import type { Db } from 'mongodb';
import { lineQtyToBase, legacyLineQtyToBase, pickBaseUom } from '@/lib/uom/conversion';
import type { ProductUom } from '@/lib/uom/types';
import { listProductUoms, listProductUomsByProductIds } from '@/lib/api/product-uom';

export type LineQtyInput = {
  qty?: number | string;
  uomId?: string;
  satuan?: string;
};

export type ResolvedLineQty = {
  qty: number;
  qtyBase: number;
  uomId?: string;
  satuan?: string;
  factorToBase: number;
};

export type ResolvedStockLine = ResolvedLineQty & { stokId: string };

export type StockLineInput = LineQtyInput & {
  stokId: string;
};

function parseQty(v?: number | string): number {
  return parseFloat(String(v ?? 0)) || 0;
}

export function resolveLineQtyBaseFromUoms(
  input: LineQtyInput,
  uoms: ProductUom[],
): ResolvedLineQty | { error: string } {
  const qty = parseQty(input.qty);
  if (input.uomId) {
    const uom = uoms.find((u) => u.id === input.uomId);
    if (!uom) return { error: 'Satuan produk tidak ditemukan (uomId)' };
    return {
      qty,
      qtyBase: lineQtyToBase(qty, uom),
      uomId: uom.id,
      satuan: uom.satuan,
      factorToBase: uom.factorToBase,
    };
  }
  const sat = input.satuan ? String(input.satuan).trim().toUpperCase() : '';
  if (sat) {
    const uom = uoms.find((u) => u.satuan === sat);
    if (uom) {
      return {
        qty,
        qtyBase: lineQtyToBase(qty, uom),
        uomId: uom.id,
        satuan: uom.satuan,
        factorToBase: uom.factorToBase,
      };
    }
  }
  const base = pickBaseUom(uoms);
  return {
    qty,
    qtyBase: legacyLineQtyToBase(qty),
    uomId: base?.id,
    satuan: base?.satuan || sat || undefined,
    factorToBase: base?.factorToBase ?? 1,
  };
}

export async function resolveLineQtyBase(
  db: Db,
  tenantId: string,
  productId: string,
  input: LineQtyInput,
  uomsCache?: Map<string, ProductUom[]>,
): Promise<ResolvedLineQty | { error: string }> {
  let uoms: ProductUom[];
  if (uomsCache?.has(productId)) {
    uoms = uomsCache.get(productId)!;
  } else {
    uoms = await listProductUoms(db, tenantId, productId);
    uomsCache?.set(productId, uoms);
  }
  return resolveLineQtyBaseFromUoms(input, uoms);
}

export async function sumQtyBaseByStokId(
  db: Db,
  tenantId: string,
  lines: StockLineInput[],
): Promise<
  | { totals: Map<string, number>; byLine: Array<{ stokId: string; resolved: ResolvedLineQty }> }
  | { error: string }
> {
  const stokIds = [...new Set(lines.map((l) => l.stokId).filter(Boolean))];
  const uomMap = await listProductUomsByProductIds(db, tenantId, stokIds);
  const totals = new Map<string, number>();
  const byLine: Array<{ stokId: string; resolved: ResolvedLineQty }> = [];
  for (const line of lines) {
    if (!line.stokId) continue;
    const uoms = uomMap.get(line.stokId) || [];
    const resolved = resolveLineQtyBaseFromUoms(line, uoms);
    if ('error' in resolved) return { error: resolved.error };
    totals.set(line.stokId, (totals.get(line.stokId) || 0) + resolved.qtyBase);
    byLine.push({ stokId: line.stokId, resolved });
  }
  return { totals, byLine };
}

export function mergeResolvedIntoLine<T extends { stokId: string }>(
  line: T,
  resolved: ResolvedLineQty,
): T & ResolvedLineQty {
  return {
    ...line,
    qty: resolved.qty,
    qtyBase: resolved.qtyBase,
    uomId: resolved.uomId,
    satuan: resolved.satuan,
    factorToBase: resolved.factorToBase,
  };
}

export function unitCostPerBaseFromLine(
  resolved: ResolvedLineQty,
  lineTotal: number,
): number {
  if (resolved.qtyBase <= 0) return 0;
  return Math.round(lineTotal / resolved.qtyBase);
}
