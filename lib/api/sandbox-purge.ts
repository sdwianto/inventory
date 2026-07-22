import type { Db, MongoClient } from 'mongodb';
import { getSalesDbName } from '@/lib/api/sandbox-config';
import {
  executeSalesSandboxRemote,
  previewSalesSandboxRemote,
  salesRemotePurgeConfigured,
} from '@/lib/api/sandbox-purge-sales-remote';

/**
 * Koleksi yang dihapus saat reset sandbox.
 * Food Production: transaksi operasional + master simulasi (resep/menu/template/price book).
 * Kitchen Assurance: observation / case / follow-up + policy & monitoring definitions.
 * Setup dapur (kitchens, service_points, temperature_thresholds) tetap.
 */
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
  'maintenance_schedules',
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
  // Food Production — dokumen operasional
  'distribution_orders',
  'temperature_logs',
  'haccp_results',
  'qc_results',
  'kitchen_transfers',
  'production_batches',
  'production_results',
  'material_issues',
  'purchase_requirements',
  'material_requirements',
  'production_plans',
  'portion_targets',
  // Food Production — master/simulasi (ikut di-reset)
  'menus',
  'recipes',
  'supplier_price_book',
  'qc_templates',
  'haccp_templates',
  // Kitchen Assurance — transaksi + definisi simulasi
  'ka_follow_ups',
  'ka_safety_cases',
  'ka_observations',
  'ka_policies',
  'ka_monitoring_definitions',
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
  'product_uom',
  'stok_lokasi',
  'kitchens',
  'service_points',
  'temperature_thresholds',
  'assets',
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
  counts: Record<string, CollectionCount | StockResetInfo | AssetResetInfo>;
  /** remote = via sales.app; mongo = langsung ke SALES_DB_NAME; remote+mongo = keduanya */
  purgeMode?: 'remote' | 'mongo' | 'remote+mongo';
  warning?: string;
};

type StockResetInfo =
  | { dryRun: true; stok_lokasi_rows: number | null; note: string }
  | { stok_lokasi: number; products: number };

type AssetResetInfo =
  | { dryRun: true; in_repair: number | null; note: string }
  | { in_repair: number };

function tenantQuery(tenantId?: string): Record<string, string> {
  const tid = String(tenantId || '').trim();
  if (!tid) return {};
  return { tenantId: tid };
}

function isFullTenantPurge(filter: Record<string, unknown>): boolean {
  return Object.keys(filter).length === 0;
}

async function countCollectionRows(
  db: Db,
  name: string,
  filter: Record<string, unknown>,
  existingNames: Set<string>,
): Promise<number | null> {
  if (!existingNames.has(name)) return null;
  try {
    return await db.collection(name).countDocuments(filter);
  } catch {
    return null;
  }
}

async function purgeOneCollection(
  db: Db,
  name: string,
  filter: Record<string, unknown>,
  existingNames: Set<string>,
  options: { fastDrop: boolean; preserveBgJobIds: string[] },
): Promise<CollectionCount> {
  if (!existingNames.has(name)) {
    return { skipped: true, before: 0, deleted: 0 };
  }

  const collFilter = (): Record<string, unknown> => {
    if (name === 'bg_jobs' && options.preserveBgJobIds.length) {
      return { ...filter, id: { $nin: options.preserveBgJobIds } };
    }
    return filter;
  };

  const f = collFilter();
  const canDrop = options.fastDrop && (name !== 'bg_jobs' || !options.preserveBgJobIds.length);

  if (canDrop) {
    const before = await db.collection(name).estimatedDocumentCount().catch(async () => (
      db.collection(name).countDocuments({})
    ));
    await db.collection(name).drop();
    return { before, deleted: before };
  }

  const r = await db.collection(name).deleteMany(f);
  return { before: r.deletedCount, deleted: r.deletedCount };
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
  const fastDrop = confirm && isFullTenantPurge(filter);

  const collectionFilter = (name: string): Record<string, unknown> => {
    if (name === 'bg_jobs' && preserveBgJobIds.length) {
      return { ...filter, id: { $nin: preserveBgJobIds } };
    }
    return filter;
  };

  const collectionResults = await Promise.all(
    SANDBOX_TRANSACTION_COLLECTIONS.map(async (name) => {
      if (!confirm) {
        if (!existingNames.has(name)) {
          return [name, { skipped: true, before: 0, deleted: 0 } as CollectionCount] as const;
        }
        const before = await db.collection(name).countDocuments(collectionFilter(name));
        return [name, { dryRun: true, before } as CollectionCount] as const;
      }
      const info = await purgeOneCollection(db, name, filter, existingNames, {
        fastDrop,
        preserveBgJobIds,
      });
      return [name, info] as const;
    }),
  );
  for (const [name, info] of collectionResults) {
    counts[name] = info;
  }

  if (confirm) {
    const now = new Date();
    const [stokLok, products, assetsRepair] = await Promise.all([
      db.collection('stok_lokasi').updateMany(filter, {
        $set: { qty: 0, qtyReserved: 0, updatedAt: now },
      }),
      db.collection('products').updateMany(filter, {
        $set: { stok: 0, updatedAt: now },
      }),
      existingNames.has('assets')
        ? db.collection('assets').updateMany(
          { ...filter, status: 'IN_REPAIR' },
          { $set: { status: 'ACTIVE', updatedAt: now } },
        )
        : Promise.resolve({ modifiedCount: 0 }),
    ]);
    counts._stock_reset = {
      stok_lokasi: stokLok.modifiedCount,
      products: products.modifiedCount,
    };
    counts._asset_reset = {
      in_repair: assetsRepair.modifiedCount,
    };
  } else {
    const [stokBefore, inRepairBefore] = await Promise.all([
      countCollectionRows(db, 'stok_lokasi', filter, existingNames),
      countCollectionRows(db, 'assets', { ...filter, status: 'IN_REPAIR' }, existingNames),
    ]);
    counts._stock_reset = {
      dryRun: true,
      stok_lokasi_rows: stokBefore,
      note: 'qty/qtyReserved/stok → 0',
    };
    counts._asset_reset = {
      dryRun: true,
      in_repair: inRepairBefore,
      note: 'status IN_REPAIR → ACTIVE',
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
  let remoteWarning: string | undefined;
  let remoteResult: SandboxDbResult | null = null;

  if (salesRemotePurgeConfigured()) {
    const remote = await previewSalesSandboxRemote(tenantId);
    if (remote?.ok) {
      remoteResult = remote.result;
    } else if (remote?.error) {
      remoteWarning = remote.error;
    }
  }

  const local = await purgeSalesLocal(client, tenantId, false);
  const remoteDocs = remoteResult ? summarizeSandboxCounts(remoteResult).documents : 0;
  const localDocs = summarizeSandboxCounts(local).documents;

  // Tampilkan sumber yang punya data lebih banyak agar preview tidak “kosong palsu”.
  if (remoteResult && remoteDocs >= localDocs) {
    return {
      ...remoteResult,
      purgeMode: 'remote',
      warning: remoteWarning,
    };
  }
  return {
    ...local,
    purgeMode: remoteResult ? 'remote+mongo' : 'mongo',
    warning: remoteWarning,
  };
}

/**
 * Purge sales harus reliable di VPS (shared mongo).
 * Remote HTTP saja bisa false-success / gagal diam-diam — selalu ikuti purge mongo lokal.
 */
async function executeSalesPurge(
  client: MongoClient,
  tenantId?: string,
): Promise<SandboxDbResult> {
  let remoteWarning: string | undefined;
  let remoteOk = false;

  if (salesRemotePurgeConfigured()) {
    const remote = await executeSalesSandboxRemote(tenantId);
    if (remote?.ok) {
      remoteOk = true;
    } else if (remote?.error) {
      remoteWarning = remote.error;
    } else {
      remoteWarning = 'Sales remote purge tidak merespons';
    }
  }

  // Authoritative: hapus transaksi di SALES_DB_NAME lewat Mongo yang sama.
  const local = await purgeSalesLocal(client, tenantId, true);
  return {
    ...local,
    purgeMode: remoteOk ? 'remote+mongo' : 'mongo',
    warning: remoteWarning,
  };
}

export async function previewSandboxPurge(
  inventoryDb: Db,
  client: MongoClient,
  options: { tenantId?: string; includeSales?: boolean } = {},
): Promise<{ inventory: SandboxDbResult; sales: SandboxDbResult | null }> {
  const { tenantId, includeSales = true } = options;

  const [inventory, sales] = await Promise.all([
    purgeSandboxDatabase(
      inventoryDb,
      'inventory',
      inventoryDb.databaseName,
      tenantId,
      false,
    ),
    includeSales ? previewSalesPurge(client, tenantId) : Promise.resolve(null),
  ]);

  return { inventory, sales };
}

export async function executeSandboxPurge(
  inventoryDb: Db,
  client: MongoClient,
  options: { tenantId?: string; includeSales?: boolean; preserveBgJobIds?: string[] } = {},
): Promise<{ inventory: SandboxDbResult; sales: SandboxDbResult | null }> {
  const { tenantId, includeSales = true, preserveBgJobIds } = options;
  const purgeOpts = preserveBgJobIds?.length ? { preserveBgJobIds } : undefined;

  // Sequential: inventory dulu, sales belakangan — error sales tidak menyembunyikan hasil inventory,
  // dan sales selalu memakai jalur mongo lokal (lihat executeSalesPurge).
  const inventory = await purgeSandboxDatabase(
    inventoryDb,
    'inventory',
    inventoryDb.databaseName,
    tenantId,
    true,
    purgeOpts,
  );

  let sales: SandboxDbResult | null = null;
  if (includeSales) {
    try {
      sales = await executeSalesPurge(client, tenantId);
    } catch (e) {
      throw new Error(
        `Inventory sudah di-reset, tetapi purge sales gagal: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  return { inventory, sales };
}

export function summarizeSandboxCounts(result: SandboxDbResult): {
  documents: number;
  collections: number;
} {
  let documents = 0;
  let collections = 0;
  for (const [name, info] of Object.entries(result.counts)) {
    if (name === '_stock_reset' || name === '_asset_reset' || name === '_sales_purge_meta') continue;
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
  const { updateJobProgress } = await import('@/lib/api/bg-jobs');
  const { getMongoClient } = await import('@/lib/api/db');
  const client = await getMongoClient();
  const preserveBgJobIds = options.preserveJobId ? [options.preserveJobId] : undefined;
  const includeSales = options.includeSales !== false;

  await updateJobProgress(inventoryDb, options.preserveJobId, {
    message: includeSales
      ? 'Menghapus transaksi inventory + sales…'
      : 'Menghapus transaksi inventory…',
    phase: 'purge',
  });

  const result = await executeSandboxPurge(inventoryDb, client, {
    tenantId: options.tenantId,
    includeSales,
    preserveBgJobIds,
  });

  await updateJobProgress(inventoryDb, options.preserveJobId, {
    message: 'Selesai',
    phase: 'done',
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
