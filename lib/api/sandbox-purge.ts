import type { Db, MongoClient } from 'mongodb';
import { getSalesDbName } from '@/lib/api/sandbox-config';
import {
  executeSalesSandboxRemote,
  previewSalesSandboxRemote,
  salesRemotePurgeConfigured,
} from '@/lib/api/sandbox-purge-sales-remote';
import { DEFAULT_FOOD_SAFETY_STATUS } from '@/lib/food-production/production-batch';
import { ensureFoodSafetyProgramsSeeded } from '@/lib/food-production/food-safety-program-seed';

/** Profil reset sandbox — `full` = perilaku lama; `kitchen-assurance` = uji KA saja. */
export type SandboxPurgeProfile = 'full' | 'kitchen-assurance';

export const SANDBOX_PURGE_PROFILES: SandboxPurgeProfile[] = ['full', 'kitchen-assurance'];

export function normalizeSandboxPurgeProfile(raw: unknown): SandboxPurgeProfile {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'kitchen-assurance' || v === 'ka') return 'kitchen-assurance';
  return 'full';
}

/**
 * Koleksi yang dihapus saat reset sandbox penuh.
 * Food Production: transaksi operasional + master simulasi (menu/template/price book).
 * Master resep (`recipes`) TIDAK ikut direset — dianggap master data, bukan data simulasi.
 * Keamanan Pangan (kode: kitchen-assurance / ka_*): observation / case / follow-up + policy & monitoring.
 * Setup dapur (kitchens, service_points, armadas, temperature_thresholds, warehouse_bins) tetap.
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
  'vendor_returns',
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
  // Warehouse / FEFO ledger (bukan master bin)
  'stok_bin',
  'putaway_moves',
  'ingredient_lots',
  // Integrasi & jejak eksekusi
  'integration_outbox',
  'audit_log',
  'execution_outbox',
  'execution_audit',
  'dashboard_snapshots',
  // Ops reconcile artifacts
  'fefo_batch_reconcile_reports',
  'ingredient_lot_reconcile_reports',
  'issue_fefo_shortfall_reports',
  'dist_fefo_shortfall_reports',
  'release_fefo_shortfall_reports',
  'dist_return_fefo_shortfall_reports',
  'hsl_waste_reconcile_reports',
  'stok_bin_reconcile_reports',
  // Food Production — dokumen operasional
  'distribution_orders',
  'temperature_logs',
  'haccp_results',
  'haccp_plans',
  'haccp_verifications',
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
  'supplier_price_book',
  'qc_templates',
  'haccp_templates',
  'food_safety_programs',
  'food_safety_requirements',
  // Keamanan Pangan (KA) — transaksi + definisi simulasi
  'ka_follow_ups',
  'ka_safety_cases',
  'ka_observations',
  'ka_policies',
  'ka_monitoring_definitions',
  'ka_follow_up_orphan_reconcile_reports',
  'ka_open_case_missing_fu_reconcile_reports',
] as const;

/**
 * Profil Keamanan Pangan (kode: kitchen-assurance): transaksi KA + jejak Food Safety uji.
 * Tidak menyentuh stok, Sales, PO/GRN, resep, program PRP, HACCP Study.
 */
export const SANDBOX_KA_COLLECTIONS = [
  'ka_follow_ups',
  'ka_safety_cases',
  'ka_observations',
  'ka_policies',
  'ka_monitoring_definitions',
  'ka_follow_up_orphan_reconcile_reports',
  'ka_open_case_missing_fu_reconcile_reports',
  'temperature_logs',
  'qc_results',
  'haccp_results',
  'haccp_verifications',
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
  'armadas',
  'temperature_thresholds',
  'warehouse_bins',
  'recipes',
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

/** Hint retain untuk profil KA (uji tanpa sentuh pengadaan/stok). */
export const SANDBOX_KA_KEEP_HINT = [
  'products',
  'product_uom',
  'stok_lokasi',
  'goods_receipts',
  'customer_purchase_orders',
  'hutang',
  'kitchens',
  'service_points',
  'armadas',
  'temperature_thresholds',
  'food_safety_programs',
  'food_safety_requirements',
  'qc_templates',
  'haccp_templates',
  'haccp_plans',
  'recipes',
  'menus',
  'production_batches',
  'users',
  'tenants',
  'tenant_settings',
] as const;

export function collectionsForSandboxProfile(
  profile: SandboxPurgeProfile,
): readonly string[] {
  return profile === 'kitchen-assurance'
    ? SANDBOX_KA_COLLECTIONS
    : SANDBOX_TRANSACTION_COLLECTIONS;
}

export function keepHintForSandboxProfile(
  profile: SandboxPurgeProfile,
): readonly string[] {
  return profile === 'kitchen-assurance' ? SANDBOX_KA_KEEP_HINT : SANDBOX_KEEP_HINT;
}

/**
 * Kunci dedupe job SANDBOX_RESET — wajib bedakan profil agar KA tidak
 * me-reuse job reset penuh (atau sebaliknya) di antrian PENDING/RUNNING.
 */
export function sandboxResetDedupeKey(opts: {
  profile?: SandboxPurgeProfile | string;
  tenantId?: string | null;
  includeSales?: boolean;
}): string {
  const profile = normalizeSandboxPurgeProfile(opts.profile);
  const scope = String(opts.tenantId || '').trim() || 'all';
  const sales = profile === 'kitchen-assurance'
    ? 0
    : opts.includeSales === false
      ? 0
      : 1;
  return `sandbox-reset:${profile}:${scope}:sales=${sales}`;
}

type CollectionCount =
  | { skipped: true; before: 0; deleted: 0 }
  | { dryRun: true; before: number }
  | { before: number; deleted: number };

export type SandboxDbResult = {
  label: string;
  dbName: string;
  counts: Record<string, CollectionCount | StockResetInfo | AssetResetInfo | BatchFoodSafetyResetInfo>;
  profile?: SandboxPurgeProfile;
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

type BatchFoodSafetyResetInfo =
  | { dryRun: true; batches: number | null; note: string }
  | { batches: number; note: string };

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
  options?: { preserveBgJobIds?: string[]; profile?: SandboxPurgeProfile },
): Promise<SandboxDbResult> {
  const profile = normalizeSandboxPurgeProfile(options?.profile);
  const collections = collectionsForSandboxProfile(profile);
  const counts: SandboxDbResult['counts'] = {};
  const filter = tenantQuery(tenantId);
  const preserveBgJobIds = (options?.preserveBgJobIds || []).map((id) => String(id).trim()).filter(Boolean);
  const existingNames = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );
  // KA profile never drop-collection (always deleteMany) — avoid nuking unrelated data if mis-scoped.
  const fastDrop = confirm && profile === 'full' && isFullTenantPurge(filter);

  const collectionFilter = (name: string): Record<string, unknown> => {
    if (name === 'bg_jobs' && preserveBgJobIds.length) {
      return { ...filter, id: { $nin: preserveBgJobIds } };
    }
    return filter;
  };

  const collectionResults = await Promise.all(
    collections.map(async (name) => {
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

  if (profile === 'kitchen-assurance') {
    await applyKaBatchFoodSafetyReset(db, filter, existingNames, confirm, counts);
    if (confirm) {
      await seedFoodSafetyProgramsAfterKaPurge(db, tenantId);
    }
    return { label, dbName, counts, profile };
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

  return { label, dbName, counts, profile };
}

async function applyKaBatchFoodSafetyReset(
  db: Db,
  filter: Record<string, unknown>,
  existingNames: Set<string>,
  confirm: boolean,
  counts: SandboxDbResult['counts'],
): Promise<void> {
  if (!existingNames.has('production_batches')) {
    counts._batch_food_safety_reset = confirm
      ? { batches: 0, note: 'collection missing' }
      : { dryRun: true, batches: 0, note: 'foodSafetyStatus → PENDING; history cleared' };
    return;
  }
  // Preview & execute memakai filter tenant yang sama (semua batch di scope),
  // agar angka dry-run tidak under-count vs updateMany.
  if (!confirm) {
    const batches = await db.collection('production_batches').countDocuments(filter);
    counts._batch_food_safety_reset = {
      dryRun: true,
      batches,
      note: 'foodSafetyStatus → PENDING; foodSafetyHistory → []',
    };
    return;
  }
  const now = new Date();
  const r = await db.collection('production_batches').updateMany(filter, {
    $set: {
      foodSafetyStatus: DEFAULT_FOOD_SAFETY_STATUS,
      foodSafetyHistory: [],
      updatedAt: now,
    },
    $unset: {
      foodSafetyHoldAt: '',
      foodSafetyHoldReason: '',
      foodSafetyHoldSourceId: '',
      foodSafetyHoldSourceType: '',
    },
  });
  counts._batch_food_safety_reset = {
    batches: r.modifiedCount,
    note: 'foodSafetyStatus → PENDING; history cleared',
  };
}

async function seedFoodSafetyProgramsAfterKaPurge(
  db: Db,
  tenantId: string | undefined,
): Promise<void> {
  const tids: string[] = [];
  if (tenantId) {
    tids.push(tenantId);
  } else {
    const fromSettings = await db.collection('tenant_settings').distinct('tenantId');
    const fromKitchens = await db.collection('kitchens').distinct('tenantId');
    for (const t of [...fromSettings, ...fromKitchens]) {
      const id = String(t || '').trim();
      if (id && !tids.includes(id)) tids.push(id);
    }
    if (!tids.length) tids.push('default');
  }
  for (const tid of tids) {
    await ensureFoodSafetyProgramsSeeded(db, tid);
  }
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
  options: {
    tenantId?: string;
    includeSales?: boolean;
    profile?: SandboxPurgeProfile;
  } = {},
): Promise<{ inventory: SandboxDbResult; sales: SandboxDbResult | null }> {
  const profile = normalizeSandboxPurgeProfile(options.profile);
  const includeSales = profile === 'kitchen-assurance'
    ? false
    : options.includeSales !== false;

  const [inventory, sales] = await Promise.all([
    purgeSandboxDatabase(
      inventoryDb,
      'inventory',
      inventoryDb.databaseName,
      options.tenantId,
      false,
      { profile },
    ),
    includeSales ? previewSalesPurge(client, options.tenantId) : Promise.resolve(null),
  ]);

  return { inventory, sales };
}

export async function executeSandboxPurge(
  inventoryDb: Db,
  client: MongoClient,
  options: {
    tenantId?: string;
    includeSales?: boolean;
    preserveBgJobIds?: string[];
    profile?: SandboxPurgeProfile;
  } = {},
): Promise<{ inventory: SandboxDbResult; sales: SandboxDbResult | null }> {
  const profile = normalizeSandboxPurgeProfile(options.profile);
  const includeSales = profile === 'kitchen-assurance'
    ? false
    : options.includeSales !== false;
  const purgeOpts = {
    ...(options.preserveBgJobIds?.length ? { preserveBgJobIds: options.preserveBgJobIds } : {}),
    profile,
  };

  // Sequential: inventory dulu, sales belakangan — error sales tidak menyembunyikan hasil inventory,
  // dan sales selalu memakai jalur mongo lokal (lihat executeSalesPurge).
  const inventory = await purgeSandboxDatabase(
    inventoryDb,
    'inventory',
    inventoryDb.databaseName,
    options.tenantId,
    true,
    purgeOpts,
  );

  let sales: SandboxDbResult | null = null;
  if (includeSales) {
    try {
      sales = await executeSalesPurge(client, options.tenantId);
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
    if (
      name === '_stock_reset'
      || name === '_asset_reset'
      || name === '_batch_food_safety_reset'
      || name === '_sales_purge_meta'
    ) continue;
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
  options: {
    tenantId?: string;
    includeSales?: boolean;
    preserveJobId?: string;
    profile?: SandboxPurgeProfile | string;
  } = {},
) {
  const { updateJobProgress } = await import('@/lib/api/bg-jobs');
  const { getMongoClient } = await import('@/lib/api/db');
  const client = await getMongoClient();
  const preserveBgJobIds = options.preserveJobId ? [options.preserveJobId] : undefined;
  const profile = normalizeSandboxPurgeProfile(options.profile);
  const includeSales = profile === 'kitchen-assurance'
    ? false
    : options.includeSales !== false;

  await updateJobProgress(inventoryDb, options.preserveJobId, {
    message: profile === 'kitchen-assurance'
      ? 'Reset Keamanan Pangan (cases, QC/HACCP results, temp logs)…'
      : includeSales
        ? 'Menghapus transaksi inventory + sales…'
        : 'Menghapus transaksi inventory…',
    phase: 'purge',
  });

  const result = await executeSandboxPurge(inventoryDb, client, {
    tenantId: options.tenantId,
    includeSales,
    preserveBgJobIds,
    profile,
  });

  await updateJobProgress(inventoryDb, options.preserveJobId, {
    message: 'Selesai',
    phase: 'done',
  });

  return {
    tenantId: options.tenantId || null,
    scope: options.tenantId ? 'tenant' : 'all',
    profile,
    includeSales,
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
