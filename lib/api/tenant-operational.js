// Operasional & akunting per tenant — migrasi, filter, stamp tenantId.

import { withTenantFilter, migrateCollectionTenantId } from '@/lib/api/tenant-master';
import { assertDocTenant, normalizeTenantId } from '@/lib/api/tenant-scope';

export const OPERATIONAL_COLLECTIONS = [
  'transactions',
  'sales_orders',
  'deliveries',
  'invoices',
  'purchase_orders',
  'pembelian',
  'hutang',
  'hutang_pembayaran',
  'piutang',
  'piutang_pembayaran',
  'stok_kartu',
  'penyesuaian_stok',
  'produksi',
  'transfer_stok',
  'jurnal',
  'kas_masuk',
  'kas_keluar',
  'retur_penjualan',
  'retur_pembelian',
  'aset_tetap',
  'member_poin',
  'penyusutan_log',
  'tutup_buku_log',
  'goods_receipts',
  'customer_purchase_orders',
  'inventory_releases',
];

let operationalMigrated = false;

export async function migrateAllOperationalTenantIds(db, defaultTenant = 'default') {
  const counts = {};
  for (const name of OPERATIONAL_COLLECTIONS) {
    counts[name] = await migrateCollectionTenantId(db, name, defaultTenant);
  }
  return counts;
}

export async function ensureOperationalTenantIds(db) {
  if (operationalMigrated) return;
  const sample = await db.collection('transactions').findOne({
    $or: [{ tenantId: { $exists: false } }, { tenantId: null }, { tenantId: '' }],
  });
  if (sample) {
    await migrateAllOperationalTenantIds(db, 'default');
  }
  operationalMigrated = true;
}

export function withOperationalFilter(auth, baseFilter = {}) {
  return withTenantFilter(auth, baseFilter);
}

export async function findOperationalDoc(db, collection, auth, query) {
  return db.collection(collection).findOne(withOperationalFilter(auth, query));
}

export function assertOperationalDoc(doc, auth) {
  return assertDocTenant(doc, auth);
}

/** Sisipkan tenantId ke dokumen insert. */
export function stampTenantId(tenantId, doc) {
  return { ...doc, tenantId: normalizeTenantId(tenantId || 'default') };
}

/** Update stok produk hanya jika id + tenant cocok. */
export async function updateProductStockScoped(db, tenantId, productId, update) {
  const tid = tenantId || 'default';
  const filter = { id: productId };
  if (tid === 'default') {
    filter.$or = [
      { tenantId: 'default' },
      { tenantId: { $exists: false } },
      { tenantId: null },
      { tenantId: '' },
    ];
  } else {
    filter.tenantId = tid;
  }
  return db.collection('products').updateOne(filter, update);
}

export function productFilterById(tenantId, productId) {
  const tid = tenantId || 'default';
  if (tid === 'default') {
    return {
      id: productId,
      $or: [
        { tenantId: 'default' },
        { tenantId: { $exists: false } },
        { tenantId: null },
        { tenantId: '' },
      ],
    };
  }
  return { id: productId, tenantId: tid };
}
