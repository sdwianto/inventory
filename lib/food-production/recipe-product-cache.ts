/**
 * Cache master produk di form resep.
 * GET /products?limit=200 (urut nama) tidak mencakup SKU di akhir alfabet (Wortel).
 * Merge + hydrate by id supaya kolom TKPI / satuan dapur tidak kosong setelah simpan.
 */

export type ProductIdRef = { id?: string | null };
export type LineProductRef = { productId?: string | null };
export type RecipeLinesRef = { lines?: LineProductRef[] | null };

export function collectRecipeProductIds(
  lines: LineProductRef[] | null | undefined,
  recipes?: RecipeLinesRef[] | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: unknown) => {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const line of lines || []) push(line?.productId);
  for (const recipe of recipes || []) {
    for (const line of recipe?.lines || []) push(line?.productId);
  }
  return out;
}

export function missingProductIds(
  needed: string[],
  have: ProductIdRef[],
): string[] {
  const haveSet = new Set(
    have.map((p) => String(p?.id || '').trim()).filter(Boolean),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of needed) {
    const id = String(raw || '').trim();
    if (!id || haveSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Primary menang jika id sama; extras mengisi yang belum ada. */
export function mergeProductCache<T extends { id: string }>(
  primary: T[],
  extras: T[],
): T[] {
  const byId = new Map<string, T>();
  for (const p of extras) {
    const id = String(p?.id || '').trim();
    if (!id) continue;
    byId.set(id, p);
  }
  for (const p of primary) {
    const id = String(p?.id || '').trim();
    if (!id) continue;
    byId.set(id, p);
  }
  return [...byId.values()];
}
