/** Strict lokasi qty — no fallback to products.stok. */

export function qtyAtWarehouse(
  byWh: Record<string, number> | undefined,
  kode: string,
): number {
  if (!byWh || !kode) return 0;
  const v = byWh[kode];
  if (v == null) return 0;
  return parseFloat(String(v)) || 0;
}
