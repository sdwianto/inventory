import type { Db } from 'mongodb';
// Siapkan baris PO untuk dikirim ke sales.app — kode produk = single source of truth di master.

import type { JsonObject } from '@/types/json';

type ProductDoc = JsonObject & { id?: string; kode?: string; nama?: string; vendorStokId?: string; vendorTenantId?: string };

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

export async function enrichPoItemsForVendor(db: Db, tenantId: string, items: JsonObject[]) {
  const tid = tenantId || 'default';
  const maps = await loadProductsBatch(db, tid, items);
  const enriched: JsonObject[] = [];

  for (const it of items || []) {
    const prod = resolveProduct(it, maps);

    const vendorStokId = prod?.vendorStokId || it.vendorStokId || '';
    const vendorKode = prod?.kode || it.vendorKode || it.kode || '';
    const itemVendorTenantId = prod?.vendorTenantId || it.vendorTenantId || '';

    if (!vendorStokId || !itemVendorTenantId) {
      return {
        error: `Produk "${it.nama || vendorKode || it.localStokId}" (kode ${vendorKode || '?'}) belum terdaftar di Master Produk atau belum disync dari sales.app. Daftarkan produk dengan kode yang sama lalu jalankan Sync Katalog.`,
      };
    }

    enriched.push({
      kode: vendorKode,
      vendorStokId,
      vendorTenantId: itemVendorTenantId,
      qty: parseFloat(String(it.qty)) || 0,
      nama: it.nama || prod?.nama,
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
