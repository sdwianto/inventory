import type { Db } from 'mongodb';
// Single source of truth: kode produk per vendor di sales.app.

const LOCAL_VENDOR_ID = '_local';

export async function resolveProductByKode(
  db: Db,
  tenantId: string | null | undefined,
  vendorTenantId: string | null | undefined,
  vendorItem: { kode?: string; stokId?: string },
) {
  const tid = tenantId || 'default';
  const kode = String(vendorItem?.kode || '').trim();
  const vid = String(vendorTenantId || '').trim();
  const stokId = String(vendorItem?.stokId || '').trim();

  if (stokId && vid) {
    const byStok = await db.collection('products').findOne({
      tenantId: tid,
      vendorStokId: stokId,
      vendorTenantId: vid,
      aktif: { $ne: false },
    });
    if (byStok) {
      return {
        localStokId: byStok.id,
        localKode: byStok.kode,
        localNama: byStok.nama,
      };
    }
  }

  if (kode && vid) {
    const byVendorKode = await db.collection('products').findOne({
      tenantId: tid,
      vendorTenantId: vid,
      kode,
      aktif: { $ne: false },
    });
    if (byVendorKode) {
      return {
        localStokId: byVendorKode.id,
        localKode: byVendorKode.kode,
        localNama: byVendorKode.nama,
      };
    }
  }

  if (kode) {
    const local = await db.collection('products').findOne({
      tenantId: tid,
      kode,
      aktif: { $ne: false },
      $or: [
        { syncSource: { $ne: 'sales.app' } },
        { vendorTenantId: { $in: [null, '', LOCAL_VENDOR_ID] } },
        { vendorTenantId: { $exists: false } },
      ],
    });
    if (local) {
      return {
        localStokId: local.id,
        localKode: local.kode,
        localNama: local.nama,
      };
    }
  }

  return { localStokId: null, localKode: null, localNama: null };
}
