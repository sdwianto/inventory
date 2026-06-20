// Siapkan baris PO untuk dikirim ke sales.app — kode produk = single source of truth di master.

export async function enrichPoItemsForVendor(db, tenantId, items) {
  const tid = tenantId || 'default';
  const enriched = [];

  for (const it of items || []) {
    let prod = null;
    if (it.localStokId) {
      prod = await db.collection('products').findOne({ tenantId: tid, id: it.localStokId });
    }
    if (!prod && it.vendorStokId && it.vendorTenantId) {
      prod = await db.collection('products').findOne({
        tenantId: tid,
        vendorTenantId: it.vendorTenantId,
        vendorStokId: it.vendorStokId,
      });
    }
    if (!prod && (it.kode || it.vendorKode)) {
      const kode = it.vendorKode || it.kode;
      prod = await db.collection('products').findOne({ tenantId: tid, kode, aktif: { $ne: false } });
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
      qty: parseFloat(it.qty) || 0,
      nama: it.nama || prod?.nama,
      estimasiHarga: parseInt(it.estimasiHarga || 0, 10),
      harga: parseInt(it.estimasiHarga || 0, 10),
    });
  }

  if (!enriched.length) return { error: 'PO tidak punya item valid' };
  return { items: enriched };
}

export function groupPoItemsByVendorTenant(items) {
  const groups = new Map();
  for (const it of items || []) {
    const vTenant = it.vendorTenantId;
    if (!vTenant) {
      return { error: `Produk "${it.kode || it.nama || '?'}" tanpa vendorTenantId — sync ulang katalog` };
    }
    if (!groups.has(vTenant)) groups.set(vTenant, []);
    groups.get(vTenant).push(it);
  }
  if (!groups.size) return { error: 'PO tidak punya item valid' };
  return {
    groups: [...groups.entries()].map(([vendorTenantId, groupItems]) => ({ vendorTenantId, items: groupItems })),
  };
}
