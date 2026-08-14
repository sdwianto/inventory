import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureFoodSafetyProgramsSeeded = vi.fn(
  async () => ({ programs: 1, requirements: 1, seeded: false }),
);

vi.mock('@/lib/food-production/food-safety-program-seed', () => ({
  ensureFoodSafetyProgramsSeeded: (...args: unknown[]) => ensureFoodSafetyProgramsSeeded(...args),
}));

import {
  SANDBOX_KA_COLLECTIONS,
  SANDBOX_TRANSACTION_COLLECTIONS,
  collectionsForSandboxProfile,
  keepHintForSandboxProfile,
  normalizeSandboxPurgeProfile,
  purgeSandboxDatabase,
  sandboxResetDedupeKey,
  summarizeSandboxCounts,
  type SandboxDbResult,
} from '@/lib/api/sandbox-purge';

describe('sandbox purge profile kitchen-assurance', () => {
  it('normalizes profile aliases', () => {
    expect(normalizeSandboxPurgeProfile('kitchen-assurance')).toBe('kitchen-assurance');
    expect(normalizeSandboxPurgeProfile('ka')).toBe('kitchen-assurance');
    expect(normalizeSandboxPurgeProfile('full')).toBe('full');
    expect(normalizeSandboxPurgeProfile(undefined)).toBe('full');
    expect(normalizeSandboxPurgeProfile('')).toBe('full');
  });

  it('dedupe keys separate KA vs full and tenant scope', () => {
    const ka = sandboxResetDedupeKey({
      profile: 'kitchen-assurance',
      tenantId: 'sppg',
      includeSales: true,
    });
    const full = sandboxResetDedupeKey({
      profile: 'full',
      tenantId: 'sppg',
      includeSales: true,
    });
    const fullNoSales = sandboxResetDedupeKey({
      profile: 'full',
      tenantId: 'sppg',
      includeSales: false,
    });
    const kaAll = sandboxResetDedupeKey({ profile: 'ka', tenantId: '' });
    expect(ka).toBe('sandbox-reset:kitchen-assurance:sppg:sales=0');
    expect(full).toBe('sandbox-reset:full:sppg:sales=1');
    expect(fullNoSales).toBe('sandbox-reset:full:sppg:sales=0');
    expect(kaAll).toBe('sandbox-reset:kitchen-assurance:all:sales=0');
    expect(ka).not.toBe(full);
  });

  it('KA profile collections are a strict subset and exclude procurement/stock', () => {
    const ka = collectionsForSandboxProfile('kitchen-assurance');
    expect(ka).toEqual([...SANDBOX_KA_COLLECTIONS]);
    expect(ka).toContain('ka_safety_cases');
    expect(ka).toContain('qc_results');
    expect(ka).toContain('haccp_results');
    expect(ka).toContain('temperature_logs');
    expect(ka).not.toContain('goods_receipts');
    expect(ka).not.toContain('stok_kartu');
    expect(ka).not.toContain('customer_purchase_orders');
    expect(ka).not.toContain('hutang');
    expect(ka).not.toContain('recipes');
    expect(ka).not.toContain('haccp_plans');
    expect(ka).not.toContain('production_batches');
    expect(ka).not.toContain('bg_jobs');
  });

  it('full profile still includes KA + procurement collections', () => {
    const full = collectionsForSandboxProfile('full');
    expect(full).toEqual([...SANDBOX_TRANSACTION_COLLECTIONS]);
    expect(full).toContain('goods_receipts');
    expect(full).toContain('ka_safety_cases');
  });

  it('KA keep hint documents stok and GRN retention', () => {
    const hint = keepHintForSandboxProfile('kitchen-assurance');
    expect(hint).toEqual(expect.arrayContaining([
      'stok_lokasi',
      'goods_receipts',
      'kitchens',
      'haccp_plans',
      'food_safety_programs',
    ]));
  });
});

describe('purgeSandboxDatabase kitchen-assurance', () => {
  beforeEach(() => {
    ensureFoodSafetyProgramsSeeded.mockClear();
  });

  function mockDb(opts: {
    collectionNames: string[];
    counts?: Record<string, number>;
    batchDocs?: number;
  }) {
    const deleted: Record<string, number> = {};
    const updated: Record<string, number> = {};
    const counts = opts.counts || {};

    const collection = (name: string) => ({
      countDocuments: vi.fn(async () => counts[name] ?? 0),
      estimatedDocumentCount: vi.fn(async () => counts[name] ?? 0),
      deleteMany: vi.fn(async () => {
        const n = counts[name] ?? 0;
        deleted[name] = n;
        return { deletedCount: n };
      }),
      drop: vi.fn(async () => {
        deleted[name] = counts[name] ?? 0;
      }),
      updateMany: vi.fn(async () => {
        const n = name === 'production_batches' ? (opts.batchDocs ?? 0) : 0;
        updated[name] = n;
        return { modifiedCount: n };
      }),
      distinct: vi.fn(async () => ['t1']),
    });

    return {
      db: {
        databaseName: 'test_inv',
        listCollections: () => ({
          toArray: async () => opts.collectionNames.map((name) => ({ name })),
        }),
        collection,
      } as never,
      deleted,
      updated,
    };
  }

  it('dry-run KA does not report goods_receipts / stock reset', async () => {
    const { db } = mockDb({
      collectionNames: [
        ...SANDBOX_KA_COLLECTIONS,
        'goods_receipts',
        'stok_lokasi',
        'production_batches',
        'tenant_settings',
        'kitchens',
      ],
      counts: {
        ka_safety_cases: 3,
        goods_receipts: 99,
        stok_lokasi: 50,
        production_batches: 2,
      },
      batchDocs: 2,
    });

    const result = await purgeSandboxDatabase(db, 'inventory', 'test_inv', 't1', false, {
      profile: 'kitchen-assurance',
    });

    expect(result.profile).toBe('kitchen-assurance');
    expect(result.counts.ka_safety_cases).toEqual({ dryRun: true, before: 3 });
    expect(result.counts.goods_receipts).toBeUndefined();
    expect(result.counts._stock_reset).toBeUndefined();
    expect(result.counts._asset_reset).toBeUndefined();
    expect(result.counts._batch_food_safety_reset).toMatchObject({ dryRun: true });
  });

  it('execute KA deletes KA collections and resets batch food safety, not GRN', async () => {
    const { db, deleted, updated } = mockDb({
      collectionNames: [
        ...SANDBOX_KA_COLLECTIONS,
        'goods_receipts',
        'stok_lokasi',
        'production_batches',
        'tenant_settings',
        'kitchens',
      ],
      counts: {
        ka_safety_cases: 2,
        qc_results: 1,
        goods_receipts: 10,
      },
      batchDocs: 4,
    });

    const result = await purgeSandboxDatabase(db, 'inventory', 'test_inv', 't1', true, {
      profile: 'kitchen-assurance',
    });

    expect(deleted.ka_safety_cases).toBe(2);
    expect(deleted.qc_results).toBe(1);
    expect(deleted.goods_receipts).toBeUndefined();
    expect(updated.production_batches).toBe(4);
    expect(updated.stok_lokasi).toBeUndefined();
    expect(result.counts._stock_reset).toBeUndefined();
    expect(ensureFoodSafetyProgramsSeeded).toHaveBeenCalledWith(db, 't1');
  });
});

describe('summarizeSandboxCounts with batch reset meta', () => {
  it('ignores _batch_food_safety_reset in document totals', () => {
    const result: SandboxDbResult = {
      label: 'inventory',
      dbName: 'x',
      counts: {
        ka_safety_cases: { dryRun: true, before: 5 },
        _batch_food_safety_reset: { dryRun: true, batches: 9, note: 'x' },
      },
    };
    expect(summarizeSandboxCounts(result)).toEqual({ documents: 5, collections: 1 });
  });
});
