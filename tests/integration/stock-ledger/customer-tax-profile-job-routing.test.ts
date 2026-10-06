/**
 * CUSTOMER_TAX_PROFILE_PUSH harus masuk antrean domain `inventory` dan diproses inventory-worker
 * (regresi: tipe di luar kontrak jatuh ke domain `sales` → PENDING selamanya).
 * Suite di-skip bila mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';

const pushCalls: Array<Record<string, unknown>> = [];

vi.mock('@/lib/api/integration-links', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/integration-links')>('@/lib/api/integration-links');
  return {
    ...actual,
    resolveSalesApiAccess: async () => ({ salesAppUrl: 'http://sales.test', salesApiKey: 'k' }),
  };
});

vi.mock('@/lib/integration/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/integration/client')>('@/lib/integration/client');
  return {
    ...actual,
    createIntegrationClient: () => ({
      pushCustomerTaxProfile: async (input: Record<string, unknown>) => {
        pushCalls.push(input);
        return { applied: true };
      },
    }),
  };
});

const { enqueueCustomerTaxProfilePush } = await import('@/lib/api/customer-tax-profile-push');
const { enqueueJob, JOB_TYPES } = await import('@/lib/api/bg-jobs');
const { processOneTick } = await import('@/lib/execution/runtime/worker-runner');
const { ShutdownController } = await import('@/lib/execution/runtime/worker-shutdown');
const { clearHandlersForTests, getRegisteredHandler } = await import('@/lib/execution/workers/registry');
const { registerInventoryHandlers } = await import('@/lib/execution/workers/register-inventory');
const { setJobBusAdapter } = await import('@/lib/execution/dispatcher/bus-adapter');
const { setExecutionEventBus } = await import('@sdwianto/events');
const { resetExecutionPlatformWiringForTests } = await import('@/lib/execution/runtime/platform-bootstrap');
const { resetConcurrencyForTests, setConcurrencyForTests } = await import('@/lib/execution/runtime/concurrency');
const { normalizeLegacyJobs } = await import('@sdwianto/platform/recovery/normalize-legacy-jobs');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };
let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-taxpush';
const ORIGINAL_ENV = { ...process.env };

describe.skipIf(!MongoMemoryReplSet)('Routing job CUSTOMER_TAX_PROFILE_PUSH (Mongo replica set)', { timeout: 90_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('taxpush_routing_it');
    await db.collection('tenant_settings').insertOne({
      tenantId: TID, companyNPWP: '01.234.567.8-901.000', companyAddress: 'Jl. Uji 1', tax: { pkp: true },
      taxProfileUpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    await db.collection('integration_links').insertMany([
      { customerTenantId: TID, vendorTenantId: 'v1', status: 'ACTIVE' },
      { customerTenantId: TID, vendorTenantId: 'v2', status: 'ACTIVE' },
    ]);
  });

  afterAll(async () => {
    process.env = { ...ORIGINAL_ENV };
    resetExecutionPlatformWiringForTests();
    setJobBusAdapter(null);
    setExecutionEventBus(null);
    resetConcurrencyForTests();
    await client?.close();
    await rs?.stop();
  });

  beforeEach(async () => {
    process.env.JOB_BUS_ENABLED = '1';
    process.env.DEPLOYMENT_MODE = 'vps';
    process.env.EXECUTION_LEGACY_BG = '0';
    clearHandlersForTests();
    resetExecutionPlatformWiringForTests();
    setJobBusAdapter({ publish: vi.fn().mockResolvedValue(undefined) });
    setExecutionEventBus(null);
    resetConcurrencyForTests();
    setConcurrencyForTests({ acquireTenantSlot: async () => true });
    registerInventoryHandlers();
    pushCalls.length = 0;
    await db.collection('bg_jobs').deleteMany({});
  });

  it('semua tipe job Inventory punya handler domain inventory', () => {
    for (const type of Object.values(JOB_TYPES)) {
      const h = getRegisteredHandler(type);
      expect(h, type).toBeTruthy();
      expect(h!.domain, type).toBe('inventory');
    }
  });

  it('enqueue (mode VPS) → domain inventory → diklaim inventory-worker → profil terkirim, status link OK', async () => {
    await enqueueCustomerTaxProfilePush(db, TID, 'v1', { schedule: false });
    const job = await db.collection('bg_jobs').findOne({ type: 'CUSTOMER_TAX_PROFILE_PUSH' });
    expect(job).toMatchObject({ domain: 'inventory', status: 'PENDING', jobSchemaVersion: expect.any(Number) });

    const ran = await processOneTick({
      domain: 'inventory',
      workerId: 'inventory-worker-1',
      capabilities: ['WEBHOOK', 'CPU_BATCH', 'SYNC', 'MAINTENANCE'],
      db,
      shutdown: new ShutdownController(),
    });
    expect(ran).toBe(true);
    expect((await db.collection('bg_jobs').findOne({ id: job!.id }))!.status).toBe('SUCCEEDED');
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].body).toMatchObject({ customerTenantId: TID, vendorTenantId: 'v1' });
    const link = await db.collection('integration_links').findOne({ customerTenantId: TID, vendorTenantId: 'v1' });
    expect(link!.taxProfileSync).toMatchObject({ status: 'OK', applied: true });
  });

  it('jalur format lama: normalizeLegacyJobs tidak lagi memberi domain sales', async () => {
    delete process.env.DEPLOYMENT_MODE;
    process.env.JOB_BUS_ENABLED = '0';
    await enqueueJob(db, { type: 'CUSTOMER_TAX_PROFILE_PUSH', tenantId: TID, payload: { dedupeKey: 'legacy-1' } });
    const legacy = await db.collection('bg_jobs').findOne({ 'payload.dedupeKey': 'legacy-1' });
    expect(legacy!.jobSchemaVersion).toBeUndefined();
    await normalizeLegacyJobs(db);
    expect((await db.collection('bg_jobs').findOne({ _id: legacy!._id }))!.domain).toBe('inventory');
  });
});
