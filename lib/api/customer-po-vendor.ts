import type { Db } from 'mongodb';
// Siapkan baris PO untuk dikirim ke sales.app — kode produk = single source of truth di master.

import type { JsonObject } from '@/types/json';
import { findProductUomsByIds, listProductUomsByProductIds } from '@/lib/api/product-uom';
import { isCatalogProductActive, loadLiveProductMap } from '@/lib/api/resolve-live-catalog-product';
import type { ProductUom } from '@/lib/uom/types';

type ProductDoc = JsonObject & {
  id?: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  vendorStokId?: string;
  vendorTenantId?: string;
  vendorBaseUomId?: string;
  syncSource?: string;
  aktif?: boolean;
};

async function loadProductsBatch(db: Db, tenantId: string, items: JsonObject[]) {
  const tid = tenantId || 'default';
  const localIds = new Set<string>();
  const vendorPairs: { vendorTenantId: string; vendorStokId: string }[] = [];
  const kodeLookups: { kode: string; vendorTenantId?: string }[] = [];

  for (const it of items || []) {
    if (it.localStokId) localIds.add(String(it.localStokId));
    if (it.vendorStokId && it.vendorTenantId) {
      vendorPairs.push({
        vendorTenantId: String(it.vendorTenantId),
        vendorStokId: String(it.vendorStokId),
      });
    }
    if (it.kode || it.vendorKode) {
      kodeLookups.push({
        kode: String(it.vendorKode || it.kode),
        vendorTenantId: it.vendorTenantId ? String(it.vendorTenantId) : undefined,
      });
    }
  }

  const byLocalId = new Map<string, ProductDoc>();
  const byVendorKey = new Map<string, ProductDoc>();
  const byKode = new Map<string, ProductDoc>();

  if (localIds.size) {
    const rows = await db.collection('products')
      .find({ tenantId: tid, id: { $in: [...localIds] } })
      .toArray() as ProductDoc[];
    for (const p of rows) {
      if (p.id) byLocalId.set(p.id, p);
    }
  }

  if (vendorPairs.length) {
    const rows = await db.collection('products').find({
      tenantId: tid,
      $or: vendorPairs.map((v) => ({
        vendorTenantId: v.vendorTenantId,
        vendorStokId: v.vendorStokId,
      })),
    }).toArray() as ProductDoc[];
    for (const p of rows) {
      byVendorKey.set(`${p.vendorTenantId}:${p.vendorStokId}`, p);
    }
  }

  const uniqueKodes = [...new Set(kodeLookups.map((k) => k.kode))];
  if (uniqueKodes.length) {
    const rows = await db.collection('products').find({
      tenantId: tid,
      kode: { $in: uniqueKodes },
      aktif: { $ne: false },
    }).toArray() as ProductDoc[];
    for (const p of rows) {
      const key = p.vendorTenantId ? `${p.vendorTenantId}:${p.kode}` : String(p.kode);
      if (!byKode.has(key)) byKode.set(key, p);
      if (p.kode && !byKode.has(String(p.kode))) byKode.set(String(p.kode), p);
    }
  }

  return { byLocalId, byVendorKey, byKode };
}

function resolveProduct(
  it: JsonObject,
  maps: Awaited<ReturnType<typeof loadProductsBatch>>,
): ProductDoc | null {
  if (it.localStokId) {
    const p = maps.byLocalId.get(String(it.localStokId));
    if (p) return p;
  }
  if (it.vendorStokId && it.vendorTenantId) {
    const p = maps.byVendorKey.get(`${it.vendorTenantId}:${it.vendorStokId}`);
    if (p) return p;
  }
  if (it.kode || it.vendorKode) {
    const kode = String(it.vendorKode || it.kode);
    const itemVendor = String(it.vendorTenantId || '').trim();
    if (itemVendor) {
      const p = maps.byKode.get(`${itemVendor}:${kode}`);
      if (p) return p;
    }
    return maps.byKode.get(kode) || null;
  }
  return null;
}

function normSatuan(s?: string | null): string {
  return String(s || '').trim().toUpperCase();
}

/** vendorUomId valid untuk push — bukan kosong, bukan ID lokal yang keliru. */
function isUsableVendorUomId(id?: string | null, localUomId?: string): boolean {
  const v = String(id || '').trim();
  if (!v) return false;
  if (localUomId && v === localUomId) return false;
  return true;
}

/** ID satuan sales.app nyata (bukan placeholder legacy:). */
function isRealVendorUomId(id?: string | null, localUomId?: string): boolean {
  const v = String(id || '').trim();
  if (!isUsableVendorUomId(v, localUomId)) return false;
  return !v.startsWith('legacy:');
}

/** Satuan lokal yang ditunjuk oleh vendorUomId (lewat mapping product_uom / base produk). */
function satuanForVendorUomId(
  id: string,
  productUoms: ProductUom[],
  prod: ProductDoc,
): string | undefined {
  const v = String(id).trim();
  const linked = productUoms.find(
    (u) => isRealVendorUomId(u.vendorUomId, u.id) && String(u.vendorUomId).trim() === v,
  );
  if (linked) return normSatuan(linked.satuan);
  if (isRealVendorUomId(prod.vendorBaseUomId) && String(prod.vendorBaseUomId).trim() === v) {
    return normSatuan(prod.satuan);
  }
  return undefined;
}

/**
 * vendorBaseUomId hanya boleh dipakai jika satuan yang diminta cocok dengan satuan dasar produk
 * (atau baris memang satuan dasar). Hindari stamp ONS base pada baris KG/BAK.
 */
export function vendorBaseUomIdIfCompatible(
  prod: { vendorBaseUomId?: string | null; satuan?: string | null },
  satuanWant?: string | null,
  matchedIsBase?: boolean,
): string {
  const fromProduct = prod.vendorBaseUomId != null ? String(prod.vendorBaseUomId).trim() : '';
  if (!fromProduct || fromProduct.startsWith('legacy:')) return '';
  const want = normSatuan(satuanWant);
  const prodSat = normSatuan(prod.satuan);
  if (!want || want === prodSat || matchedIsBase) return fromProduct;
  return '';
}

/** vendorUomId di baris PO hanya dipakai jika masih dikenal dan cocok satuan baris. */
function isKnownLineVendorUomId(
  id: string | undefined | null,
  productUoms: ProductUom[],
  prod: ProductDoc,
  localUomId?: string,
  targetSatuan?: string,
): boolean {
  if (!isRealVendorUomId(id, localUomId)) return false;
  const v = String(id).trim();
  const target = normSatuan(targetSatuan);
  if (target) {
    const idSat = satuanForVendorUomId(v, productUoms, prod);
    // ID dikenal tapi beda satuan (mis. ONS base pada baris KG) — tolak, biar rebind by satuan.
    if (idSat && idSat !== target) return false;
  }
  if (productUoms.some((u) => isRealVendorUomId(u.vendorUomId, u.id) && String(u.vendorUomId).trim() === v)) {
    return true;
  }
  if (isRealVendorUomId(prod.vendorBaseUomId) && String(prod.vendorBaseUomId).trim() === v) {
    // Hanya jika tanpa target, atau target sudah cocok (dicek di atas).
    return !target || normSatuan(prod.satuan) === target;
  }
  // Belum ada mapping nyata di katalog — izinkan ID baris (bootstrap / isi manual).
  return !productUoms.some((u) => isRealVendorUomId(u.vendorUomId, u.id));
}

/** Cari vendorUomId untuk push PO — toleran data lama / uomId stale setelah sync. */
export function resolveVendorUomId(
  prod: ProductDoc,
  localUom: ProductUom | undefined,
  productUoms: ProductUom[],
  satuanHint?: string,
  lineVendorUomId?: string,
): string | undefined {
  const target = normSatuan(localUom?.satuan || satuanHint);

  // 1) ID eksplisit di baris PO — dikenal + cocok satuan (bukan UUID usang / base salah)
  if (isKnownLineVendorUomId(lineVendorUomId, productUoms, prod, localUom?.id, target)) {
    return String(lineVendorUomId).trim();
  }

  // 2) Mapping di product_uom yang sudah punya vendorUomId nyata (satuan baris)
  if (isRealVendorUomId(localUom?.vendorUomId, localUom?.id)) {
    return String(localUom!.vendorUomId).trim();
  }

  const linked = productUoms.find(
    (u) => normSatuan(u.satuan) === target && isRealVendorUomId(u.vendorUomId, u.id),
  );
  if (linked?.vendorUomId) return String(linked.vendorUomId).trim();

  const baseLinked = productUoms.find((u) => u.isBase && isRealVendorUomId(u.vendorUomId, u.id));
  if (baseLinked?.vendorUomId && (!target || normSatuan(baseLinked.satuan) === target)) {
    return String(baseLinked.vendorUomId).trim();
  }

  // 3) vendorBaseUomId dari snapshot katalog sales — hanya jika satuan cocok
  const prodVendorBase = vendorBaseUomIdIfCompatible(prod, target || satuanHint, localUom?.isBase);
  if (prodVendorBase) return prodVendorBase;

  // 4) Legacy / baris PO yang masih pakai legacy: — last resort (hanya jika satuan cocok atau tak diketahui)
  if (isUsableVendorUomId(lineVendorUomId, localUom?.id)) {
    const idSat = satuanForVendorUomId(String(lineVendorUomId), productUoms, prod);
    if (!target || !idSat || idSat === target) return String(lineVendorUomId).trim();
  }
  if (isUsableVendorUomId(localUom?.vendorUomId, localUom?.id)) {
    return String(localUom!.vendorUomId).trim();
  }

  const vendorStokId = String(prod.vendorStokId || '').trim();
  if (prod.syncSource === 'sales.app' && vendorStokId && localUom?.isBase !== false) {
    const base = productUoms.find((u) => u.isBase) || productUoms[0];
    if (base && (!target || normSatuan(base.satuan) === target)) {
      return `legacy:${vendorStokId}`;
    }
    if (!productUoms.length && (!target || normSatuan(String(prod.satuan || '')) === target || !target)) {
      return `legacy:${vendorStokId}`;
    }
  }

  return undefined;
}

export async function enrichPoItemsForVendor(db: Db, tenantId: string, items: JsonObject[]) {
  const tid = tenantId || 'default';
  const maps = await loadProductsBatch(db, tid, items);
  const uomIds = [...new Set(
    (items || []).map((it) => it.uomId).filter(Boolean).map(String),
  )];
  const uomById = await findProductUomsByIds(db, tid, uomIds);

  const productIds = [...new Set(
    (items || [])
      .map((it) => resolveProduct(it, maps)?.id)
      .filter(Boolean)
      .map(String),
  )];
  const liveMap = await loadLiveProductMap(db, tid, productIds);
  const liveIds = [...new Set(productIds.map((id) => String(liveMap.get(id)?.id || id)))];
  const uomsByProduct = await listProductUomsByProductIds(db, tid, liveIds);

  const enriched: JsonObject[] = [];

  for (const it of items || []) {
    const resolved = resolveProduct(it, maps);
    const prod = (resolved?.id ? liveMap.get(String(resolved.id)) : null) || resolved;

    if (prod && !isCatalogProductActive(prod)) {
      const label = String(prod.nama || prod.kode || it.nama || it.kode || '?');
      const kode = String(prod.kode || it.kode || it.vendorKode || '');
      return {
        error: `Produk "${label}"${kode ? ` (${kode})` : ''} sudah tidak aktif di katalog sales.app. `
          + `Di sales.app aktifkan lagi produk tersebut lalu Sync Katalog, `
          + `atau Edit PO ini dan ganti/hapus baris produk itu sebelum Setujui.`,
      };
    }

    const vendorStokId = String(prod?.vendorStokId || it.vendorStokId || '').trim();
    const vendorKode = prod?.kode || it.vendorKode || it.kode || '';
    const itemVendorTenantId = prod?.vendorTenantId || it.vendorTenantId || '';

    if (!vendorStokId || !itemVendorTenantId) {
      return {
        error: `Produk "${it.nama || vendorKode || it.localStokId}" (kode ${vendorKode || '?'}) belum terdaftar di Master Produk atau belum disync dari sales.app. Daftarkan produk dengan kode yang sama lalu jalankan Sync Katalog.`,
      };
    }

    const qty = parseFloat(String(it.qty)) || 0;
    let satuan = it.satuan ? String(it.satuan) : undefined;
    let vendorUomId: string | undefined;

    const productUoms = prod?.id ? (uomsByProduct.get(String(prod.id)) || []) : [];
    let localUom = it.uomId ? uomById.get(String(it.uomId)) : undefined;
    if (!localUom && it.uomId && productUoms.length) {
      localUom = productUoms.find((u) => u.id === String(it.uomId));
    }
    // Label satuan baris menang atas uomId yang masih ada di DB tapi beda satuan (ONS vs KG).
    const orderHint = normSatuan(it.satuan ? String(it.satuan) : undefined);
    if (orderHint && productUoms.length) {
      const byOrder = productUoms.find((u) => normSatuan(u.satuan) === orderHint);
      if (byOrder && (!localUom || normSatuan(localUom.satuan) !== orderHint)) {
        localUom = byOrder;
      }
    }
    if (!localUom && productUoms.length) {
      localUom = productUoms.find((u) => u.isBase) || productUoms[0];
    }

    if (localUom || it.uomId || it.satuan || it.vendorUomId) {
      if (localUom) satuan = localUom.satuan;
      vendorUomId = resolveVendorUomId(
        prod || { vendorStokId, syncSource: 'sales.app' },
        localUom,
        productUoms,
        it.satuan ? String(it.satuan) : undefined,
        it.vendorUomId ? String(it.vendorUomId) : undefined,
      );
      if (!vendorUomId) {
        return {
          error: `Satuan "${localUom?.satuan || it.satuan || '?'}" untuk "${it.nama || vendorKode}" belum terhubung ke sales.app — jalankan Sync Katalog.`,
        };
      }
      // Guard: vendorUomId yang dikirim harus cocok satuan order (cegah KG→ONS / BAK→PTG senyap)
      const resolvedSat = satuanForVendorUomId(vendorUomId, productUoms, prod || {});
      const orderSat = normSatuan(satuan || localUom?.satuan || it.satuan);
      if (resolvedSat && orderSat && resolvedSat !== orderSat && !vendorUomId.startsWith('legacy:')) {
        return {
          error: `Satuan baris "${orderSat}" untuk "${it.nama || vendorKode}" tidak cocok mapping vendor (${resolvedSat}). `
            + `Jalankan Sync Katalog, lalu Edit PO dan pastikan satuan terhubung sebelum kirim.`,
        };
      }
      // legacy: sering ditolak sales jika produk sudah punya UOM nyata — minta sync ulang
      if (vendorUomId.startsWith('legacy:') && !productUoms.some((u) => isRealVendorUomId(u.vendorUomId, u.id))) {
        return {
          error: `Satuan "${satuan || '?'}" untuk "${it.nama || vendorKode}" belum punya uomId sales.app — jalankan Sync Katalog, lalu Retry kirim PO.`,
        };
      }
    }

    enriched.push({
      lineId: it.lineId ? String(it.lineId) : undefined,
      kode: vendorKode,
      vendorStokId,
      vendorTenantId: itemVendorTenantId,
      qty,
      nama: it.nama || prod?.nama,
      satuan,
      uomId: vendorUomId,
      /** Local catalog uom id — untuk persist binding kembali ke CPO. */
      localUomId: localUom?.id || (it.uomId ? String(it.uomId) : undefined),
      estimasiHarga: parseInt(String(it.estimasiHarga || 0), 10),
      harga: parseInt(String(it.estimasiHarga || 0), 10),
    });
  }

  if (!enriched.length) return { error: 'PO tidak punya item valid' };
  return { items: enriched };
}

/** Terapkan hasil enrich ke baris CPO (vendorUomId + uomId lokal + satuan). */
export function applyEnrichedBindingsToPoItems(
  poItems: JsonObject[],
  enrichedItems: JsonObject[],
): JsonObject[] {
  return (poItems || []).map((it, idx) => {
    const e = enrichedItems[idx];
    if (!e) return it;
    const next = { ...it };
    if (e.satuan != null && String(e.satuan).trim()) next.satuan = String(e.satuan);
    if (e.uomId != null && String(e.uomId).trim()) next.vendorUomId = String(e.uomId);
    if (e.localUomId != null && String(e.localUomId).trim()) next.uomId = String(e.localUomId);
    return next;
  });
}

export function groupPoItemsByVendorTenant(items: JsonObject[]) {
  const groups = new Map<string, JsonObject[]>();
  for (const it of items || []) {
    const vTenant = String(it.vendorTenantId || '');
    if (!vTenant) {
      return { error: `Produk "${it.kode || it.nama || '?'}" tanpa vendorTenantId — sync ulang katalog` };
    }
    if (!groups.has(vTenant)) groups.set(vTenant, []);
    groups.get(vTenant)!.push(it);
  }
  if (!groups.size) return { error: 'PO tidak punya item valid' };
  return {
    groups: [...groups.entries()].map(([vendorTenantId, groupItems]) => ({ vendorTenantId, items: groupItems })),
  };
}
