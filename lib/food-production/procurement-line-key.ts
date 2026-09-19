import { normalizeRecipeSatuan } from '@/lib/food-production/recipe-uom';

/**
 * Kunci pengadaan: kode item + satuan, bukan productId.
 * Berlaku untuk SEMUA kode — satu menu hari bisa memakai resep berbeda yang
 * menunjuk salinan katalog (productId beda) untuk kode yang sama.
 * PR/PO harus satu baris per kode+satuan.
 */
export function procurementLineKey(input: {
  productId?: string | null;
  productKode?: string | null;
  kode?: string | null;
  vendorKode?: string | null;
  satuan?: string | null;
  uomId?: string | null;
  localStokId?: string | null;
}): string {
  const kode = String(input.productKode || input.kode || input.vendorKode || '')
    .trim()
    .toUpperCase();
  const sat = normalizeRecipeSatuan(input.satuan) || String(input.uomId || '').trim();
  if (kode) return `kode:${kode}::${sat}`;
  const id = String(input.productId || input.localStokId || '').trim();
  return `id:${id}::${sat}`;
}

export function sameProcurementIdentity(
  a: Parameters<typeof procurementLineKey>[0],
  b: Parameters<typeof procurementLineKey>[0],
): boolean {
  const ka = procurementLineKey(a);
  const kb = procurementLineKey(b);
  return Boolean(ka) && ka === kb;
}

/**
 * Jika satu kode punya baris tanpa satuan dan tepat satu satuan terisi,
 * gabungkan yang kosong ke satuan itu (mapping UOM kadang kehilangan label).
 * Jangan gabung jika kode yang sama sudah punya dua satuan berbeda.
 */
export function foldEmptySatuanMap<T>(
  map: Map<string, T>,
  merge: (a: T, b: T) => T,
): Map<string, T> {
  const byKode = new Map<string, string[]>();
  for (const key of map.keys()) {
    if (!key.startsWith('kode:')) continue;
    const kode = key.slice('kode:'.length).split('::')[0];
    if (!kode) continue;
    const list = byKode.get(kode) || [];
    list.push(key);
    byKode.set(kode, list);
  }
  for (const keys of byKode.values()) {
    const empty = keys.filter((k) => k.endsWith('::'));
    const filled = keys.filter((k) => !k.endsWith('::'));
    if (!empty.length || filled.length !== 1) continue;
    const target = filled[0];
    const base = map.get(target);
    if (!base) continue;
    let acc = base;
    for (const e of empty) {
      const extra = map.get(e);
      if (!extra) continue;
      acc = merge(acc, extra);
      map.delete(e);
    }
    map.set(target, acc);
  }
  return map;
}
