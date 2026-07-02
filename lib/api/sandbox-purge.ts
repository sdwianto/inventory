import type { Db, MongoClient } from 'mongodb';
import { getSalesDbName } from '@/lib/api/sandbox-config';

/** Koleksi transaksi — urutan: anak dulu, induk belakangan (sama dengan scripts/purge-transactions.mjs). */
export const SANDBOX_TRANSACTION_COLLECTIONS = [
  'hutang_pembayaran',
  'piutang_pembayaran',
  'hutang',
  'piutang',
  'credit_notes',
  'stok_kartu',
  'penyesuaian_stok',
  'produksi',
  'transfer_stok',
  'retur_penjualan',
  'retur_pembelian',
  'pembelian',
  'purchase_orders',
  'invoices',
  'deliveries',
  'sales_orders',
  'transactions',
  'customer_purchase_orders',
  'local_purchase_orders',
  'goods_receipts',
  'inventory_releases',
  'maintenance_requests',
  'maintenance_service_orders',
  'jurnal',
  'kas_masuk',
  'kas_keluar',
  'aset_tetap',
  'penyusutan_log',
  'member_poin',
  'tutup_buku_log',
  'webhook_delivery_log',
  'webhook_inbox',
  'stock_reservations',
  'document_sequences',
] as const;

export const SANDBOX_KEEP_HINT = [
  'products',
  'supplier',
  'pelanggan',
  'pelanggan_profiles',
  'members',
  'rekening',
  'lokasi',
  'produk_grup',
  'produk_satuan',
  'stok_lokasi',
  'assets',
  'maintenance_schedules',
  'users',
  'tenants',
  'tenant_settings',
  'api_keys',
  'webhook_subscriptions',
  'integration_settings',
  'vendor_tenants',
  'vendor_product_map',
  'customer_price_lists',
  'pelanggan_migration_map',
  'integration_links',
] as const;

type CollectionCount =
  | { skipped: true; before: 0; deleted: 0 }
  | { dryRun: true; before: number }
  | { before: number; deleted: number };

export type SandboxDbResult = {
  label: string;
  dbName: string;
  counts: Record<string, CollectionCount | StockResetInfo>;
};

type StockResetInfo =
  | { dryRun: true; stok_lokasi_rows: number | null; note: string }
  | { stok_lokasi: number; products: number };

function tenantQuery(tenantId?: string): Record<string, string> {
  const tid = String(tenantId || '').trim();
  if (!tid) return {};
  return { tenantId: tid };
}

async function collectionExists(db: Db, name: string): Promise<boolean> {
  const cols = await db.listCollections({ name }).toArray();
  return cols.length > 0;
}

async function countCollection(db: Db, name: string, tenantId?: string): Promise<number | null> {
  try {
    if (!(await collectionExists(db, name))) return null;
    return db.collection(name).countDocuments(tenantQuery(tenantId));
  } catch {
    return null;
  }
}

async function purgeDb(
  db: Db,
  label: string,
  dbName: string,
  tenantId: string | undefined,
  confirm: boolean,
): Promise<SandboxDbResult> {
  const counts: SandboxDbResult['counts'] = {};
  const filter = tenantQuery(tenantId);

  for (const name of SANDBOX_TRANSACTION_COLLECTIONS) {
    const before = await countCollection(db, name, tenantId);
    if (before === null) {
      counts[name] = { skipped: true, before: 0, deleted: 0 };
      continue;
    }
    if (!confirm) {
      counts[name] = { dryRun: true, before };
      continue;
    }
    const r = await db.collection(name).deleteMany(filter);
    counts[name] = { before, deleted: r.deletedCount };
  }

  if (confirm) {
    const now = new Date();
    const stokLok = await db.collection('stok_lokasi').updateMany(filter, {
      $set: { qty: 0, qtyReserved: 0, updatedAt: now },
    });
    const products = await db.collection('products').updateMany(filter, {
      $set: { stok: 0, updatedAt: now },
    });
    counts._stock_reset = {
      stok_lokasi: stokLok.modifiedCount,
      products: products.modifiedCount,
    };
  } else {
    const stokBefore = await countCollection(db, 'stok_lokasi', tenantId);
    counts._stock_reset = {
      dryRun: true,
      stok_lokasi_rows: stokBefore,
      note: 'qty/qtyReserved/stok → 0',
    };
  }

  return { label, dbName, counts };
}

export async function previewSandboxPurge(
  inventoryDb: Db,
  client: MongoClient,
  options: { tenantId?: string; includeSales?: boolean } = {},
): Promise<{ inventory: SandboxDbResult; sales: SandboxDbResult | null }> {
  const { tenantId, includeSales = true } = options;
  const inventory = await purgeDb(
    inventoryDb,
    'inventory',
    inventoryDb.databaseName,
    tenantId,
    false,
  );

  if (!includeSales) {
    return { inventory, sales: null };
  }

  const salesDb = client.db(getSalesDbName());
  const sales = await purgeDb(salesDb, 'sales', salesDb.databaseName, tenantId, false);
  return { inventory, sales };
}

export async function executeSandboxPurge(
  inventoryDb: Db,
  client: MongoClient,
  options: { tenantId?: string; includeSales?: boolean } = {},
): Promise<{ inventory: SandboxDbResult; sales: SandboxDbResult | null }> {
  const { tenantId, includeSales = true } = options;
  const inventory = await purgeDb(
    inventoryDb,
    'inventory',
    inventoryDb.databaseName,
    tenantId,
    true,
  );

  if (!includeSales) {
    return { inventory, sales: null };
  }

  const salesDb = client.db(getSalesDbName());
  const sales = await purgeDb(salesDb, 'sales', salesDb.databaseName, tenantId, true);
  return { inventory, sales };
}

export function summarizeSandboxCounts(result: SandboxDbResult): {
  documents: number;
  collections: number;
} {
  let documents = 0;
  let collections = 0;
  for (const [name, info] of Object.entries(result.counts)) {
    if (name === '_stock_reset') continue;
    if ('skipped' in info && info.skipped) continue;
    if ('dryRun' in info && 'before' in info) {
      documents += info.before;
      if (info.before > 0) collections += 1;
      continue;
    }
    if ('before' in info && !('dryRun' in info)) {
      documents += info.before;
      if (info.before > 0) collections += 1;
    }
  }
  return { documents, collections };
}
