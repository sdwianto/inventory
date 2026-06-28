import type { Db } from 'mongodb';
// Siapkan baris PO untuk dikirim ke sales.app — kode produk = single source of truth di master.

import type { JsonObject } from '@/types/json';

type ProductDoc = JsonObject & { id?: string; kode?: string; nama?: string; vendorStokId?: string; vendorTenantId?: string };

export async function enrichPoItemsForVendor(db: Db, tenantId: string, items: JsonObject[]) {
  const tid = tenantId || 'default';
  const enriched: JsonObject[] = [];

  for (const it of items || []) {
    let prod: ProductDoc | null = null;
    if (it.localStokId) {
      prod = await db.collection('products').findOne({ tenantId: tid, id: it.localStokId }) as ProductDoc | null;
    }
    if (!prod && it.vendorStokId && it.vendorTenantId) {
      prod = await db.collection('products').findOne({
        tenantId: tid,
        vendorTenantId: it.vendorTenantId,
        vendorStokId: it.vendorStokId,
      }) as ProductDoc | null;
    }
    if (!prod && (it.kode || it.vendorKode)) {
      const kode = it.vendorKode || it.kode;
      prod = await db.collection('products').findOne({ tenantId: tid, kode, aktif: { $ne: false } }) as ProductDoc | null;
    }

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
