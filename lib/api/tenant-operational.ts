import type { Db, Filter } from 'mongodb';
// Operasional & akunting per tenant — migrasi, filter, stamp tenantId.

import { withTenantFilter, migrateCollectionTenantId } from '@/lib/api/tenant-master';
import { assertDocTenant, normalizeTenantId } from '@/lib/api/tenant-scope';
import type { AuthContext } from '@/types/auth';

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
  'vendor_returns',
  'customer_purchase_orders',
  'local_purchase_orders',
  'maintenance_requests',
  'maintenance_service_orders',
  'inventory_releases',
  'kitchen_people',
  'people',
  'person_payments',
  'bank_txn_inbox',
];

let operationalMigrated = false;

export async function migrateAllOperationalTenantIds(db: Db, defaultTenant = 'default') {
  const counts: Record<string, unknown> = {};
  for (const name of OPERATIONAL_COLLECTIONS) {
    counts[name] = await migrateCollectionTenantId(db, name, defaultTenant);
  }
  return counts;
}

export async function ensureOperationalTenantIds(db: Db) {
  if (operationalMigrated) return;
  const sample = await db.collection('transactions').findOne({
    $or: [{ tenantId: { $exists: false } }, { tenantId: null }, { tenantId: '' }],
  });
  if (sample) {
    await migrateAllOperationalTenantIds(db, 'default');
  }
  operationalMigrated = true;
}

export function withOperationalFilter(
  auth: AuthContext | null | undefined,
  baseFilter: Filter<Record<string, unknown>> = {},
) {
  return withTenantFilter(auth, baseFilter);
}

export async function findOperationalDoc(
  db: Db,
  collection: string,
  auth: AuthContext | null | undefined,
  query: Filter<Record<string, unknown>>,
) {
  return db.collection(collection).findOne(withOperationalFilter(auth, query));
}

export function assertOperationalDoc(
  doc: Record<string, unknown> | null | undefined,
  auth: AuthContext | null | undefined,
) {
  return assertDocTenant(doc, auth);
}

/** Sisipkan tenantId ke dokumen insert. */
export function stampTenantId<T extends Record<string, unknown>>(tenantId: string, doc: T) {
  return { ...doc, tenantId: normalizeTenantId(tenantId || 'default') };
}

export function productFilterById(tenantId: string, productId: string) {
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
