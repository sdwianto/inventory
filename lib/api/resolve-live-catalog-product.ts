/**
 * Satu kode item bisa punya beberapa dokumen `products` di tenant inventory
 * (salinan vendor berbeda setelah daftar multi-tenant di sales.app).
 * Resep/PR sering masih menunjuk salinan lama yang sudah nonaktif.
 * Helper ini memilih baris katalog yang masih hidup.
 */

export type LiveCatalogProduct = {
  id?: string;
  kode?: string;
  nama?: string;
  aktif?: boolean;
  vendorTenantId?: string;
  vendorStokId?: string;
  masterProductId?: string | null;
  cutoverToKode?: string;
  satuan?: string;
  itemRole?: string;
  hargaBeli?: number;
  vendorBaseUomId?: string;
  syncSource?: string;
  recipeBaseGrams?: number;
  recipeBaseMl?: number;
  nutrition?: { gramsPerUnit?: number };
};

export function isCatalogProductActive(p: LiveCatalogProduct | null | undefined): boolean {
  return !!p && p.aktif !== false;
}

/** Pilih salinan aktif: vendor yang sama → master yang sama → kode cutover → kode yang sama. */
export function pickLiveCatalogProduct(
  current: LiveCatalogProduct,
  candidates: LiveCatalogProduct[],
): LiveCatalogProduct | null {
  const active = candidates.filter((p) => isCatalogProductActive(p) && p.id && p.id !== current.id);
  if (!active.length) return null;

  const kode = String(current.kode || '').trim();
  const vendor = String(current.vendorTenantId || '').trim();
  const master = String(current.masterProductId || '').trim();
  const cutover = String(current.cutoverToKode || '').trim();

  if (vendor && kode) {
    const sameVendor = active.find(
      (p) => String(p.vendorTenantId || '').trim() === vendor && String(p.kode || '').trim() === kode,
    );
    if (sameVendor) return sameVendor;
  }
  if (master) {
    const sameMaster = active.find((p) => String(p.masterProductId || '').trim() === master);
    if (sameMaster) return sameMaster;
  }
  if (cutover) {
    const byCutover = active.find((p) => String(p.kode || '').trim() === cutover);
    if (byCutover) return byCutover;
  }
  if (kode) {
    const byKode = active.find((p) => String(p.kode || '').trim() === kode);
    if (byKode) return byKode;
  }
  return null;
}

type ProductColl = {
  find: (filter: Record<string, unknown>) => { toArray: () => Promise<LiveCatalogProduct[]> };
};

export async function attachLiveCatalogProducts(
  db: { collection: (name: string) => ProductColl },
  tenantId: string,
  products: LiveCatalogProduct[],
): Promise<Map<string, LiveCatalogProduct>> {
  const map = new Map<string, LiveCatalogProduct>();
  const inactive: LiveCatalogProduct[] = [];
  for (const p of products) {
    const id = String(p.id || '').trim();
    if (!id) continue;
    if (isCatalogProductActive(p)) map.set(id, p);
    else inactive.push(p);
  }
  if (!inactive.length) return map;

  const kodes = new Set<string>();
  const masters = new Set<string>();
  for (const p of inactive) {
    const kode = String(p.kode || '').trim();
    if (kode) kodes.add(kode);
    const cutover = String(p.cutoverToKode || '').trim();
    if (cutover) kodes.add(cutover);
    const master = String(p.masterProductId || '').trim();
    if (master) masters.add(master);
  }
  const or: Record<string, unknown>[] = [];
  if (kodes.size) or.push({ kode: { $in: [...kodes] } });
  if (masters.size) or.push({ masterProductId: { $in: [...masters] } });

  const siblings = or.length
    ? await db.collection('products').find({
      tenantId,
      aktif: { $ne: false },
      $or: or,
    }).toArray()
    : [];

  for (const p of inactive) {
    const id = String(p.id || '').trim();
    if (!id) continue;
    map.set(id, pickLiveCatalogProduct(p, siblings) || p);
  }
  return map;
}

export async function loadLiveProductMap(
  db: { collection: (name: string) => ProductColl },
  tenantId: string,
  ids: string[],
): Promise<Map<string, LiveCatalogProduct>> {
  const unique = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!unique.length) return new Map();
  const products = await db.collection('products').find({
    tenantId,
    id: { $in: unique },
  }).toArray();
  return attachLiveCatalogProducts(db, tenantId, products);
}

export function liveProductId(
  liveMap: Map<string, LiveCatalogProduct>,
  productId: string,
): string {
  const live = liveMap.get(productId);
  return String(live?.id || productId);
}
