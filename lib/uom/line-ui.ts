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
