/**
 * Item persediaan kanonik vs salinan vendor.
 *
 * Satu kode = satu item persediaan (stok, lot, kartu, resep, MRP, RL). Salinan katalog per vendor
 * (sinkron sales.app) tetap disimpan dengan `mergedInto` → id kanonik: vendorStokId, satuan vendor,
 * dan harga per vendor tetap dipakai dokumen pembelian (CPO/GRN/retur/hutang). Posting stok dari
 * dokumen pembelian dipetakan ke item kanonik lewat resolveStockProducts.
 */

import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import { logger } from '@/lib/api/logger';
import { roundStockQty } from '@/lib/stock-ledger/precision';
import type { ProductUom } from '@/lib/uom/types';

export const PRODUCT_KODE_UNIQUE_INDEX = 'uniq_products_tenant_kode_active';

/** Partial filter index unik kode: produk aktif (atau tanpa field aktif) yang bukan salinan tergabung. */
export const PRODUCT_KODE_UNIQUE_FILTER = {
  aktif: { $in: [true, null] },
  mergedInto: null,
  kode: { $gt: '' },
} as const;

/** Filter daftar item persediaan: sembunyikan salinan vendor yang sudah digabung. */
export const NOT_MERGED_PRODUCT_FILTER = { mergedInto: null } as const;

export type CatalogIdentityRow = {
  id: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  aktif?: boolean;
  vendorAktif?: boolean;
  mergedInto?: string | null;
  syncSource?: string;
  vendorTenantId?: string;
  vendorTenantName?: string;
  vendorStokId?: string;
  vendorHargaBeli?: number;
  gudangKode?: string;
};

export function mergedTargetId(p: { mergedInto?: unknown } | null | undefined): string {
  return String(p?.mergedInto || '').trim();
}

export function normalizeBaseSatuan(s: unknown): string {
  return String(s || '').trim().toUpperCase();
}

export function isDuplicateKodeError(e: unknown): boolean {
  const err = e as { code?: number; message?: string; keyPattern?: Record<string, unknown> } | null;
  if (err?.code !== 11000) return false;
  return String(err.message || '').includes(PRODUCT_KODE_UNIQUE_INDEX);
}

export type StockProductTarget = {
  /** Id di dokumen sumber (bisa salinan vendor). */
  sourceId: string;
  /** Item persediaan yang menerima mutasi. */
  productId: string;
  merged: boolean;
  product: Record<string, unknown>;
};

/**
 * Id produk dokumen → item persediaan untuk posting stok.
 * Salinan tergabung hanya boleh diposting bila satuan dasarnya sama dengan item kanonik
 * (qty satuan dasar dipindah apa adanya — tidak ada faktor konversi lokal yang bisa basi saat sync UOM vendor).
 */
export async function resolveStockProducts(
  db: Db,
  tenantId: string,
  ids: string[],
  session?: ClientSession,
): Promise<{ targets: Map<string, StockProductTarget> } | { error: string }> {
  const unique = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  const targets = new Map<string, StockProductTarget>();
  if (!unique.length) return { targets };
  const rows = await db.collection('products')
    .find({ tenantId, id: { $in: unique } }, txOpts(session))
    .toArray() as unknown as Array<Record<string, unknown> & CatalogIdentityRow>;
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const canonicalIds = [...new Set(rows.map(mergedTargetId).filter(Boolean))];
  const canonRows = canonicalIds.length
    ? await db.collection('products')
      .find({ tenantId, id: { $in: canonicalIds } }, txOpts(session))
      .toArray() as unknown as Array<Record<string, unknown> & CatalogIdentityRow>
    : [];
  const canonById = new Map(canonRows.map((r) => [String(r.id), r]));

  for (const id of unique) {
    const row = byId.get(id);
    if (!row) continue;
    const target = mergedTargetId(row);
    if (!target) {
      targets.set(id, { sourceId: id, productId: id, merged: false, product: row });
      continue;
    }
    const canon = canonById.get(target);
    if (!canon) return { error: `Item persediaan ${target} untuk produk ${row.kode || id} tidak ditemukan` };
    if (mergedTargetId(canon)) {
      return { error: `Produk ${row.kode || id} menunjuk item yang juga sudah digabung — jalankan ulang alat gabung kode` };
    }
    const src = normalizeBaseSatuan(row.satuan);
    const dst = normalizeBaseSatuan(canon.satuan);
    if (src && dst && src !== dst) {
      return {
        error: `Produk ${row.kode || id} dari vendor ${row.vendorTenantName || row.vendorTenantId || '-'} memakai satuan dasar ${src}, `
          + `sedangkan item persediaan memakai ${dst}. Samakan satuan dasar master di sales.app sebelum posting stok.`,
      };
    }
    targets.set(id, { sourceId: id, productId: target, merged: true, product: canon });
  }
  return { targets };
}

/**
 * Item kanonik untuk kode (produk baru dari vendor lain di-link ke sini).
 * Hanya bila tepat satu dokumen non-gabung memakai kode itu — kode yang masih ganda
 * diselesaikan alat gabung (migrasi 0003), bukan ditebak di sini.
 */
export async function findKodeCanonical(
  db: Db,
  tenantId: string,
  kode: string,
  opts: { excludeId?: string; session?: ClientSession } = {},
): Promise<CatalogIdentityRow | null> {
  const k = String(kode || '').trim();
  if (!k) return null;
  const filter: Record<string, unknown> = { tenantId, kode: k, ...NOT_MERGED_PRODUCT_FILTER };
  if (opts.excludeId) filter.id = { $ne: opts.excludeId };
  const rows = await db.collection('products')
    .find(filter, txOpts(opts.session))
    .project({ id: 1, kode: 1, satuan: 1, aktif: 1, syncSource: 1 })
    .limit(50)
    .toArray() as unknown as CatalogIdentityRow[];
  return pickKodeCanonical(rows);
}

/**
 * Index unik kode hanya menjaga produk aktif, jadi satu kode boleh punya satu aktif + beberapa nonaktif.
 * Kanonik = satu-satunya yang aktif; bila semua nonaktif, hanya bila tinggal satu dokumen.
 */
function pickKodeCanonical(rows: CatalogIdentityRow[]): CatalogIdentityRow | null {
  const active = rows.filter((r) => r.aktif !== false);
  if (active.length === 1) return active[0];
  if (!active.length && rows.length === 1) return rows[0];
  return null;
}

/** Peta kode → item kanonik untuk batch sync (lihat pickKodeCanonical). */
export async function findKodeCanonicalBatch(
  db: Db,
  tenantId: string,
  kodes: string[],
): Promise<Map<string, CatalogIdentityRow>> {
  const unique = [...new Set(kodes.map((k) => String(k || '').trim()).filter(Boolean))];
  const out = new Map<string, CatalogIdentityRow>();
  if (!unique.length) return out;
  const rows = await db.collection('products')
    .find({ tenantId, kode: { $in: unique }, ...NOT_MERGED_PRODUCT_FILTER })
    .project({ id: 1, kode: 1, satuan: 1, aktif: 1, syncSource: 1 })
    .toArray() as unknown as CatalogIdentityRow[];
  const byKode = new Map<string, CatalogIdentityRow[]>();
  for (const r of rows) {
    const k = String(r.kode || '').trim();
    byKode.set(k, [...(byKode.get(k) || []), r]);
  }
  for (const [k, list] of byKode) {
    const canon = pickKodeCanonical(list);
    if (canon) out.set(k, canon);
  }
  return out;
}

/**
 * Item kanonik sales.app aktif selama vendornya sendiri ATAU salah satu sumber vendor masih aktif.
 * Status vendor asli disimpan di `vendorAktif`. Produk lokal tidak disentuh (aktif = keputusan pengguna).
 */
export async function refreshCanonicalAktif(
  db: Db,
  tenantId: string,
  canonicalIds: string[],
  session?: ClientSession,
): Promise<number> {
  const unique = [...new Set(canonicalIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!unique.length) return 0;
  const opts = txOpts(session);
  const canon = await db.collection('products')
    .find({ tenantId, id: { $in: unique }, syncSource: 'sales.app', ...NOT_MERGED_PRODUCT_FILTER }, opts)
    .project({ id: 1, aktif: 1, vendorAktif: 1 })
    .toArray() as unknown as CatalogIdentityRow[];
  if (!canon.length) return 0;
  const activeSources = await db.collection('products')
    .aggregate([
      { $match: { tenantId, mergedInto: { $in: canon.map((c) => c.id) }, aktif: { $ne: false } } },
      { $group: { _id: '$mergedInto' } },
    ], opts)
    .toArray();
  const hasActiveSource = new Set(activeSources.map((r) => String(r._id)));
  const withSources = await db.collection('products')
    .distinct('mergedInto', { tenantId, mergedInto: { $in: canon.map((c) => c.id) } }, opts) as string[];
  const isCanonical = new Set(withSources.map(String));
  let changed = 0;
  for (const c of canon) {
    const own = c.vendorAktif ?? (c.aktif !== false);
    const next = own !== false || (isCanonical.has(c.id) && hasActiveSource.has(c.id));
    if ((c.aktif !== false) === next) continue;
    try {
      await db.collection('products').updateOne(
        { tenantId, id: c.id },
        { $set: { aktif: next, vendorAktif: own !== false, updatedAt: new Date() } },
        opts,
      );
    } catch (e) {
      // Reaktivasi bentrok dengan produk aktif lain berkode sama — biarkan nonaktif, selesaikan lewat alat gabung.
      if (!next || !isDuplicateKodeError(e) || session) throw e;
      logger.warn('canonical_reactivate_kode_conflict', { tenantId, productId: c.id });
      await db.collection('products').updateOne(
        { tenantId, id: c.id },
        { $set: { vendorAktif: own !== false, updatedAt: new Date() } },
      );
      continue;
    }
    changed += 1;
  }
  return changed;
}

/**
 * Salinan vendor tergabung yang kodenya diganti vendor ikut pindah ke item kanonik kode baru bila ada.
 * Bila belum ada, tetap di item lama (rename master di sales.app sampai per vendor dalam urutan acak;
 * item kanonik lama biasanya menyusul berganti kode). Aman karena salinan tergabung tidak memegang stok.
 */
export async function relinkMergedCopyForKode(
  db: Db,
  tenantId: string,
  existing: Record<string, unknown>,
  nextKode: string,
  now: Date,
): Promise<{ patch: Record<string, unknown>; canonicalIds: string[] } | null> {
  const from = mergedTargetId(existing);
  const kode = String(nextKode || '').trim();
  if (!from || !kode || String(existing.kode || '').trim() === kode) return null;
  const canon = await findKodeCanonical(db, tenantId, kode, { excludeId: String(existing.id || '') });
  if (!canon || canon.id === from) return null;
  return { patch: { mergedInto: canon.id, mergedAt: now, mergeSource: 'SYNC_AUTO' }, canonicalIds: [from, canon.id] };
}

/** uomId produk sumber → uomId item kanonik dengan satuan dan faktor ke satuan dasar yang sama. */
export function buildUomIdMap(
  sourceUoms: Array<Pick<ProductUom, 'id' | 'satuan' | 'factorToBase'>>,
  canonUoms: Array<Pick<ProductUom, 'id' | 'satuan' | 'factorToBase'>>,
): Map<string, string> {
  const key = (u: Pick<ProductUom, 'satuan' | 'factorToBase'>) => `${normalizeBaseSatuan(u.satuan)}|${roundStockQty(u.factorToBase || 1)}`;
  const byKey = new Map(canonUoms.map((u) => [key(u), u.id]));
  const out = new Map<string, string>();
  for (const u of sourceUoms) {
    const target = byKey.get(key(u));
    if (u.id && target) out.set(u.id, target);
  }
  return out;
}

/** Pemeta uomId baris dokumen pembelian (milik salinan vendor) → uomId item kanonik untuk kartu stok. */
export async function loadStockUomMapper(
  db: Db,
  tenantId: string,
  targets: Map<string, StockProductTarget>,
): Promise<(sourceId: string, uomId: string | undefined) => string | undefined> {
  const merged = [...targets.values()].filter((t) => t.merged);
  if (!merged.length) return (_sourceId, uomId) => uomId;
  const ids = [...new Set(merged.flatMap((t) => [t.sourceId, t.productId]))];
  const rows = await db.collection('product_uom')
    .find({ tenantId, productId: { $in: ids }, aktif: { $ne: false } })
    .project({ id: 1, productId: 1, satuan: 1, factorToBase: 1 })
    .toArray() as unknown as Array<Pick<ProductUom, 'id' | 'productId' | 'satuan' | 'factorToBase'>>;
  const byProduct = new Map<string, typeof rows>();
  for (const r of rows) byProduct.set(r.productId, [...(byProduct.get(r.productId) || []), r]);
  const maps = new Map(merged.map((t) => [t.sourceId, buildUomIdMap(byProduct.get(t.sourceId) || [], byProduct.get(t.productId) || [])]));
  return (sourceId, uomId) => {
    const map = maps.get(sourceId);
    if (!map || !uomId) return uomId;
    return map.get(uomId);
  };
}

/** Id item kanonik yang terdampak perubahan status dokumen produk (dirinya atau target gabungnya). */
export function canonicalIdsForRows(rows: Array<Record<string, unknown>>): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const target = mergedTargetId(r);
    if (target) out.add(target);
    else if (r.id) out.add(String(r.id));
  }
  return [...out];
}

function vendorSellable(p: CatalogIdentityRow): boolean {
  return p.syncSource === 'sales.app' && (p.vendorAktif ?? (p.aktif !== false)) !== false && !!p.vendorStokId;
}

/**
 * Dokumen katalog yang dipesan untuk item kanonik: item itu sendiri bila vendornya masih menjual,
 * selain itu sumber vendor aktif termurah (harga beli vendor > 0), lalu nama vendor.
 */
export async function loadPurchaseSources(
  db: Db,
  tenantId: string,
  canonical: CatalogIdentityRow[],
): Promise<Map<string, CatalogIdentityRow>> {
  const out = new Map<string, CatalogIdentityRow>();
  const needSource: string[] = [];
  for (const c of canonical) {
    if (!c?.id) continue;
    if (vendorSellable(c) || c.syncSource !== 'sales.app') out.set(c.id, c);
    else needSource.push(c.id);
  }
  if (!needSource.length) return out;
  const sources = await db.collection('products')
    .find({ tenantId, mergedInto: { $in: needSource }, syncSource: 'sales.app', aktif: { $ne: false } })
    .toArray() as unknown as CatalogIdentityRow[];
  const byCanon = new Map<string, CatalogIdentityRow[]>();
  for (const s of sources) {
    if (!vendorSellable(s)) continue;
    const k = mergedTargetId(s);
    byCanon.set(k, [...(byCanon.get(k) || []), s]);
  }
  for (const id of needSource) {
    const list = (byCanon.get(id) || []).sort((a, b) => {
      const ha = Number(a.vendorHargaBeli) > 0 ? Number(a.vendorHargaBeli) : Number.POSITIVE_INFINITY;
      const hb = Number(b.vendorHargaBeli) > 0 ? Number(b.vendorHargaBeli) : Number.POSITIVE_INFINITY;
      if (ha !== hb) return ha - hb;
      return String(a.vendorTenantName || a.vendorTenantId || '').localeCompare(String(b.vendorTenantName || b.vendorTenantId || ''));
    });
    if (list[0]) out.set(id, list[0]);
  }
  return out;
}

/** Jumlah kode yang masih punya >1 produk aktif non-gabung (target kriteria terima = 0). */
export async function countActiveDuplicateKode(db: Db, tenantId: string): Promise<number> {
  const rows = await db.collection('products').aggregate([
    { $match: { tenantId, aktif: { $ne: false }, mergedInto: null, kode: { $gt: '' } } },
    { $group: { _id: '$kode', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: 'n' },
  ]).toArray();
  return Number(rows[0]?.n || 0);
}

export async function ensureProductKodeUniqueIndex(db: Db): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await db.collection('products').createIndex(
      { tenantId: 1, kode: 1 },
      { name: PRODUCT_KODE_UNIQUE_INDEX, unique: true, partialFilterExpression: PRODUCT_KODE_UNIQUE_FILTER },
    );
    return { ok: true };
  } catch (e) {
    const err = e as { code?: number; message?: string };
    if (err?.code === 85 || err?.code === 86) return { ok: true };
    return { ok: false, error: String(err?.message || e) };
  }
}
