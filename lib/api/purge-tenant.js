// Hapus semua data operasional + master data untuk satu tenantId.

import { OPERATIONAL_COLLECTIONS } from './tenant-operational';

const MASTER_COLLECTIONS = [
  'products',
  'supplier',
  'pelanggan',
  'members',
  'rekening',
  'lokasi',
  'produk_grup',
  'produk_satuan',
];

const EXTRA_COLLECTIONS = [
  'stok_lokasi',
  'goods_receipts',
  'customer_purchase_orders',
  'inventory_releases',
  'integration_settings',
  'webhook_inbox',
  'webhook_subscriptions',
  'vendor_tenants',
  'bg_jobs',
  'api_keys',
];

export async function purgeTenantData(db, tenantId, { deleteUsers = true } = {}) {
  const tid = String(tenantId || '').trim();
  if (!tid) return { error: 'tenantId kosong' };
  if (tid === 'master') return { error: 'Tenant master tidak boleh dihapus' };

  const counts = {};
  for (const name of [
    ...MASTER_COLLECTIONS,
    ...OPERATIONAL_COLLECTIONS,
    ...EXTRA_COLLECTIONS,
  ]) {
    const r = await db.collection(name).deleteMany({ tenantId: tid });
    counts[name] = r.deletedCount;
  }
  if (deleteUsers) {
    const r = await db.collection('users').deleteMany({ tenantId: tid });
    counts.users = r.deletedCount;
  }
  const settings = await db.collection('tenant_settings').deleteMany({ tenantId: tid });
  counts.tenant_settings = settings.deletedCount;
  return { tenantId: tid, counts };
}

/** Hapus mock tenant legacy `default` (Toko Barokah) sekali saat bootstrap. */
export async function removeLegacyDefaultTenant(db) {
  const [settings, userCount, productCount] = await Promise.all([
    db.collection('tenant_settings').findOne({ tenantId: 'default' }),
    db.collection('users').countDocuments({ tenantId: 'default' }),
    db.collection('products').countDocuments({ tenantId: 'default' }),
  ]);
  if (!settings && userCount === 0 && productCount === 0) {
    return { removed: false };
  }
  const result = await purgeTenantData(db, 'default', { deleteUsers: true });
  return { removed: true, ...result };
}
