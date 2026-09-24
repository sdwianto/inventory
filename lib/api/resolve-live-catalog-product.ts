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

/**
 * Id katalog disalin per tenant (SKU sales.app yang sama, UUID lokal beda).
 * Form resep kadang masih memegang id tenant lain. Pilih baris tenant ini:
 * vendorStokId yang sama, lalu kode yang unik.
 */
function onlyOne(rows: LiveCatalogProduct[]): LiveCatalogProduct | null {
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Salinan katalog antar tenant (SKU yang sama, UUID beda).
 * Urutan identitas: stok vendor → vendor+kode → master → kode cutover → kode unik.
 * Lebih dari satu kandidat pada kunci yang sama tidak dipilih.
 */
export function pickSameSkuInTenant(
  foreign: LiveCatalogProduct,
  localRows: LiveCatalogProduct[],
): LiveCatalogProduct | null {
  const active = localRows.filter((p) => isCatalogProductActive(p) && p.id);
  if (!active.length) return null;

  const stokId = String(foreign.vendorStokId || '').trim();
  const kode = String(foreign.kode || '').trim();
  const vendor = String(foreign.vendorTenantId || '').trim();
  const master = String(foreign.masterProductId || '').trim();
  const cutover = String(foreign.cutoverToKode || '').trim();

  if (stokId) {
    const byStok = active.filter((p) => String(p.vendorStokId || '').trim() === stokId);
    if (byStok.length === 1) return byStok[0];
    if (byStok.length > 1) {
      return kode
        ? onlyOne(byStok.filter((p) => String(p.kode || '').trim() === kode))
        : null;
    }
  }
  if (vendor && kode) {
    const byVendor = onlyOne(active.filter(
      (p) => String(p.vendorTenantId || '').trim() === vendor && String(p.kode || '').trim() === kode,
    ));
    if (byVendor) return byVendor;
  }
  if (master) {
    const byMaster = onlyOne(active.filter((p) => String(p.masterProductId || '').trim() === master));
    if (byMaster) return byMaster;
  }
  if (cutover) {
    const byCutover = onlyOne(active.filter((p) => String(p.kode || '').trim() === cutover));
    if (byCutover) return byCutover;
  }
  if (kode) return onlyOne(active.filter((p) => String(p.kode || '').trim() === kode));
  return null;
}

type ProductColl = {
  find: (filter: Record<string, unknown>) => {
    project: (fields: Record<string, number>) => { toArray: () => Promise<LiveCatalogProduct[]> };
    toArray: () => Promise<LiveCatalogProduct[]>;
  };
};

const SKU_MATCH_PROJECTION = {
  id: 1,
  kode: 1,
  nama: 1,
  satuan: 1,
  itemRole: 1,
  aktif: 1,
  syncSource: 1,
  recipeBaseGrams: 1,
  recipeBaseMl: 1,
  nutrition: 1,
  vendorTenantId: 1,
  vendorStokId: 1,
  masterProductId: 1,
  cutoverToKode: 1,
} as const;

type CatalogDb = { collection: (name: string) => ProductColl };

/**
 * Id yang diminta → dokumen katalog tenant ini.
 * Id yang sudah ada di tenant tetap. Id tenant lain diganti SKU yang sama
 * bila identitasnya unik (stok vendor, vendor+kode, master, atau kode).
 */
export async function resolveCatalogProductsInTenant(
  db: CatalogDb,
  tenantId: string,
  ids: string[],
): Promise<Map<string, LiveCatalogProduct>> {
  const unique = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  const map = new Map<string, LiveCatalogProduct>();
  const tid = String(tenantId || '').trim();
  if (!unique.length || !tid) return map;

  const localHits = await db.collection('products')
    .find({ tenantId: tid, id: { $in: unique } })
    .project({ ...SKU_MATCH_PROJECTION })
    .toArray();
  const found = new Set<string>();
  for (const row of localHits) {
    const id = String(row.id || '').trim();
    if (!id) continue;
    map.set(id, row);
    found.add(id);
  }

  const missing = unique.filter((id) => !found.has(id));
  if (!missing.length) return map;

  const foreign = await db.collection('products')
    .find({ id: { $in: missing } })
    .project({ ...SKU_MATCH_PROJECTION })
    .toArray();
  const stokIds = new Set<string>();
  const kodes = new Set<string>();
  const masters = new Set<string>();
  for (const row of foreign) {
    const stokId = String(row.vendorStokId || '').trim();
    const kode = String(row.kode || '').trim();
    const master = String(row.masterProductId || '').trim();
    const cutover = String(row.cutoverToKode || '').trim();
    if (stokId) stokIds.add(stokId);
    if (kode) kodes.add(kode);
    if (cutover) kodes.add(cutover);
    if (master) masters.add(master);
  }
  const or: Record<string, unknown>[] = [];
  if (stokIds.size) or.push({ vendorStokId: { $in: [...stokIds] } });
  if (kodes.size) or.push({ kode: { $in: [...kodes] } });
  if (masters.size) or.push({ masterProductId: { $in: [...masters] } });
  const candidates = or.length
    ? await db.collection('products')
      .find({ tenantId: tid, $or: or })
      .project({ ...SKU_MATCH_PROJECTION })
      .toArray()
    : [];
  for (const row of foreign) {
    const id = String(row.id || '').trim();
    const local = id ? pickSameSkuInTenant(row, candidates) : null;
    if (id && local) map.set(id, local);
  }
  return map;
}

/** Satu id milik tenant lain → dokumen SKU yang sama di tenant ini. */
export async function resolveForeignSkuInTenant(
  db: CatalogDb,
  tenantId: string,
  productId: string,
): Promise<LiveCatalogProduct | null> {
  const id = String(productId || '').trim();
  if (!id) return null;
  const map = await resolveCatalogProductsInTenant(db, tenantId, [id]);
  return map.get(id) ?? null;
}

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
  const resolved = await resolveCatalogProductsInTenant(db, tenantId, unique);
  const locals: LiveCatalogProduct[] = [];
  const seen = new Set<string>();
  for (const row of resolved.values()) {
    const id = String(row.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    locals.push(row);
  }
  const live = await attachLiveCatalogProducts(db, tenantId, locals);
  const out = new Map<string, LiveCatalogProduct>();
  for (const id of unique) {
    const row = resolved.get(id);
    if (!row?.id) continue;
    const chosen = live.get(String(row.id)) || row;
    out.set(id, chosen);
    if (chosen.id) out.set(String(chosen.id), chosen);
  }
  return out;
}

export function liveProductId(
  liveMap: Map<string, LiveCatalogProduct>,
  productId: string,
): string {
  const live = liveMap.get(productId);
  return String(live?.id || productId);
}
