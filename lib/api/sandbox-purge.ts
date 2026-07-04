import type { Db, MongoClient } from 'mongodb';
import { getSalesDbName } from '@/lib/api/sandbox-config';
import {
  executeSalesSandboxRemote,
  previewSalesSandboxRemote,
  salesRemotePurgeConfigured,
} from '@/lib/api/sandbox-purge-sales-remote';

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
  'bg_jobs',
  'idempotency_keys',
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

async function countCollection(db: Db, name: string, tenantId?: string): Promise<number | null> {
  try {
    const cols = await db.listCollections({ name }).toArray();
    if (!cols.length) return null;
    return db.collection(name).countDocuments(tenantQuery(tenantId));
  } catch {
    return null;
  }
}

/** Purge satu database MongoDB (inventory lokal atau fallback sales). */
export async function purgeSandboxDatabase(
  db: Db,
  label: string,
  dbName: string,
  tenantId: string | undefined,
  confirm: boolean,
  options?: { preserveBgJobIds?: string[] },
): Promise<SandboxDbResult> {
  const counts: SandboxDbResult['counts'] = {};
  const filter = tenantQuery(tenantId);
  const preserveBgJobIds = (options?.preserveBgJobIds || []).map((id) => String(id).trim()).filter(Boolean);
  const existingNames = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );

  const collectionFilter = (name: string): Record<string, unknown> => {
    if (name === 'bg_jobs' && preserveBgJobIds.length) {
      return { ...filter, id: { $nin: preserveBgJobIds } };
    }
    return filter;
  };

  if (!confirm) {
    for (const name of SANDBOX_TRANSACTION_COLLECTIONS) {
      if (!existingNames.has(name)) {
        counts[name] = { skipped: true, before: 0, deleted: 0 };
        continue;
      }
      const before = await db.collection(name).countDocuments(collectionFilter(name));
      counts[name] = { dryRun: true, before };
    }
  } else {
    const deletions = await Promise.all(
      SANDBOX_TRANSACTION_COLLECTIONS.map(async (name) => {
        if (!existingNames.has(name)) {
          return [name, { skipped: true, before: 0, deleted: 0 } as CollectionCount] as const;
        }
        const r = await db.collection(name).deleteMany(collectionFilter(name));
        return [name, { before: r.deletedCount, deleted: r.deletedCount } as CollectionCount] as const;
      }),
    );
    for (const [name, info] of deletions) {
      counts[name] = info;
    }
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

async function purgeSalesLocal(
  client: MongoClient,
  tenantId: string | undefined,
  confirm: boolean,
): Promise<SandboxDbResult> {
  const salesDb = client.db(getSalesDbName());
  return purgeSandboxDatabase(
    salesDb,
    'sales',
    salesDb.databaseName,
    tenantId,
    confirm,
  );
}

async function previewSalesPurge(
  client: MongoClient,
  tenantId?: string,
): Promise<SandboxDbResult> {
  if (salesRemotePurgeConfigured()) {
    const remote = await previewSalesSandboxRemote(tenantId);
    if (remote?.ok) return remote.result;
    if (remote && !remote.notFound && remote.status !== 0) {
      throw new Error(remote.error);
    }
  }
  return purgeSalesLocal(client, tenantId, false);
}

async function executeSalesPurge(
  client: MongoClient,
  tenantId?: string,
): Promise<SandboxDbResult> {
  if (salesRemotePurgeConfigured()) {
    const remote = await executeSalesSandboxRemote(tenantId);
    if (remote?.ok) return remote.result;
    if (remote && !remote.notFound && remote.status !== 0) {
      throw new Error(`Purge sales.app gagal: ${remote.error}`);
    }
  }
  return purgeSalesLocal(client, tenantId, true);
}

export async function previewSandboxPurge(
  inventoryDb: Db,
  client: MongoClient,
  options: { tenantId?: string; includeSales?: boolean } = {},
): Promise<{ inventory: SandboxDbResult; sales: SandboxDbResult | null }> {
  const { tenantId, includeSales = true } = options;

  const inventory = await purgeSandboxDatabase(
    inventoryDb,
    'inventory',
    inventoryDb.databaseName,
    tenantId,
    false,
  );

  if (!includeSales) {
    return { inventory, sales: null };
  }

  const sales = await previewSalesPurge(client, tenantId);
  return { inventory, sales };
}

export async function executeSandboxPurge(
  inventoryDb: Db,
  client: MongoClient,
  options: { tenantId?: string; includeSales?: boolean; preserveBgJobIds?: string[] } = {},
): Promise<{ inventory: SandboxDbResult; sales: SandboxDbResult | null }> {
  const { tenantId, includeSales = true, preserveBgJobIds } = options;
  const purgeOpts = preserveBgJobIds?.length ? { preserveBgJobIds } : undefined;

  const inventory = await purgeSandboxDatabase(
    inventoryDb,
    'inventory',
    inventoryDb.databaseName,
    tenantId,
    true,
    purgeOpts,
  );

  if (!includeSales) {
    return { inventory, sales: null };
  }

  const sales = await executeSalesPurge(client, tenantId);
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

export async function runSandboxResetJob(
  inventoryDb: Db,
  options: { tenantId?: string; includeSales?: boolean; preserveJobId?: string } = {},
) {
  const { getMongoClient } = await import('@/lib/api/db');
  const client = await getMongoClient();
  const preserveBgJobIds = options.preserveJobId ? [options.preserveJobId] : undefined;
  const result = await executeSandboxPurge(inventoryDb, client, {
    tenantId: options.tenantId,
    includeSales: options.includeSales,
    preserveBgJobIds,
  });
  return {
    tenantId: options.tenantId || null,
    scope: options.tenantId ? 'tenant' : 'all',
    includeSales: options.includeSales !== false,
    salesPurgeMode: salesRemotePurgeConfigured() ? 'remote' : 'mongo',
    inventory: {
      ...result.inventory,
      summary: summarizeSandboxCounts(result.inventory),
    },
    sales: result.sales
      ? { ...result.sales, summary: summarizeSandboxCounts(result.sales) }
      : null,
  };
}

export { salesRemotePurgeConfigured };
