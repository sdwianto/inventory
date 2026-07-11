import type { Db } from 'mongodb';
// Siapkan baris PO untuk dikirim ke sales.app — kode produk = single source of truth di master.

import type { JsonObject } from '@/types/json';
import { findProductUomsByIds, listProductUomsByProductIds } from '@/lib/api/product-uom';
import type { ProductUom } from '@/lib/uom/types';

type ProductDoc = JsonObject & { id?: string; kode?: string; nama?: string; vendorStokId?: string; vendorTenantId?: string; syncSource?: string };

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

/** Cari vendorUomId untuk push PO — toleran data lama / uomId stale setelah sync. */
function resolveVendorUomId(
  prod: ProductDoc,
  localUom: ProductUom | undefined,
  productUoms: ProductUom[],
  satuanHint?: string,
): string | undefined {
  if (localUom?.vendorUomId) return localUom.vendorUomId;

  const target = normSatuan(localUom?.satuan || satuanHint);
  const linked = productUoms.find((u) => normSatuan(u.satuan) === target && u.vendorUomId);
  if (linked?.vendorUomId) return linked.vendorUomId;

  const baseLinked = productUoms.find((u) => u.isBase && u.vendorUomId);
  if (baseLinked?.vendorUomId && (!target || normSatuan(baseLinked.satuan) === target)) {
    return baseLinked.vendorUomId;
  }

  const vendorStokId = String(prod.vendorStokId || '').trim();
  if (prod.syncSource === 'sales.app' && vendorStokId && localUom?.isBase !== false) {
    const base = productUoms.find((u) => u.isBase) || productUoms[0];
    if (base && (!target || normSatuan(base.satuan) === target)) {
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
  const uomsByProduct = await listProductUomsByProductIds(db, tid, productIds);

  const enriched: JsonObject[] = [];

  for (const it of items || []) {
    const prod = resolveProduct(it, maps);

    if (prod && prod.aktif === false) {
      const label = String(prod.nama || prod.kode || it.nama || it.kode || '?');
      return {
        error: `Produk "${label}" sudah tidak aktif di sales.app — jalankan Sync Katalog atau pilih produk lain.`,
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
    if (!localUom && productUoms.length) {
      const hint = normSatuan(it.satuan ? String(it.satuan) : undefined);
      localUom = productUoms.find((u) => normSatuan(u.satuan) === hint)
        || productUoms.find((u) => u.isBase)
        || productUoms[0];
    }

    if (localUom || it.uomId || it.satuan) {
      if (localUom) satuan = localUom.satuan;
      vendorUomId = resolveVendorUomId(
        prod || { vendorStokId, syncSource: 'sales.app' },
        localUom,
        productUoms,
        it.satuan ? String(it.satuan) : undefined,
      );
      if (!vendorUomId) {
        return {
          error: `Satuan "${localUom?.satuan || it.satuan || '?'}" untuk "${it.nama || vendorKode}" belum terhubung ke sales.app — jalankan Sync Katalog.`,
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
      estimasiHarga: parseInt(String(it.estimasiHarga || 0), 10),
      harga: parseInt(String(it.estimasiHarga || 0), 10),
    });
  }

  if (!enriched.length) return { error: 'PO tidak punya item valid' };
  return { items: enriched };
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
