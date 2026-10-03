import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationError } from '@/lib/integration/errors';

const pushCustomerTaxProfile = vi.fn();
const links = [
  { customerTenantId: 'buyer', vendorTenantId: 'vendor-a', status: 'ACTIVE' },
  { customerTenantId: 'buyer', vendorTenantId: 'vendor-b', status: 'ACTIVE' },
];

vi.mock('@/lib/api/integration-links', () => ({
  listActiveLinksForCustomer: async () => links,
  resolveSalesApiAccess: async (_db: unknown, _tid: string, vid: string) => ({ salesAppUrl: `http://${vid}.test`, salesApiKey: `sk_${vid}` }),
}));
vi.mock('@/lib/integration/client', () => ({
  createIntegrationClient: () => ({ pushCustomerTaxProfile }),
}));
const enqueueJob = vi.fn();
vi.mock('@/lib/api/bg-jobs', () => ({
  JOB_TYPES: { CUSTOMER_TAX_PROFILE_PUSH: 'customer_tax_profile_push' },
  enqueueJob: (...a: unknown[]) => enqueueJob(...a),
  scheduleJobProcessing: vi.fn(),
}));

import { ensureCustomerTaxProfileSynced, runCustomerTaxProfilePushJob } from '@/lib/api/customer-tax-profile-push';

const STAMP = new Date('2026-10-03T01:00:00.000Z');

function mockDb(link: Record<string, unknown> | null = null) {
  const linkUpdates: Array<{ filter: unknown; update: { $set: { taxProfileSync: Record<string, unknown> } } }> = [];
  const db = {
    collection: (name: string) => ({
      findOne: async () => (name === 'tenant_settings'
        ? { companyNPWP: '01.234.567.8-901.000', companyAddress: ' Jl. Pembeli 1 ', tax: { pkp: true }, taxProfileUpdatedAt: STAMP }
        : name === 'integration_links' ? link : null),
      updateOne: async (filter: unknown, update: never) => { linkUpdates.push({ filter, update }); return { matchedCount: 1 }; },
    }),
  } as never;
  return { db, linkUpdates };
}

describe('runCustomerTaxProfilePushJob', () => {
  beforeEach(() => pushCustomerTaxProfile.mockReset());

  it('kirim profil ke tiap vendor ter-link dengan Idempotency-Key per versi profil', async () => {
    pushCustomerTaxProfile.mockResolvedValue({ ok: true });
    const { db, linkUpdates } = mockDb();
    const r = await runCustomerTaxProfilePushJob(db, { tenantId: 'buyer', payload: {} });
    expect(r).toMatchObject({ pushed: 2, failed: 0 });
    expect(pushCustomerTaxProfile).toHaveBeenCalledTimes(2);
    const first = pushCustomerTaxProfile.mock.calls[0][0];
    expect(first).toMatchObject({
      salesAppUrl: 'http://vendor-a.test',
      apiKey: 'sk_vendor-a',
      idempotencyKey: `customer-tax-profile:buyer:vendor-a:${STAMP.toISOString()}`,
      body: { customerTenantId: 'buyer', vendorTenantId: 'vendor-a', npwp: '012345678901000', pkp: true, alamat: 'Jl. Pembeli 1', profileUpdatedAt: STAMP.toISOString() },
    });
    expect(linkUpdates.map((u) => u.update.$set.taxProfileSync.status)).toEqual(['OK', 'OK']);
  });

  it('simpan applied/reason dari Sales; 404 PELANGGAN_TIDAK_ADA dicatat FAILED tanpa retry', async () => {
    pushCustomerTaxProfile
      .mockResolvedValueOnce({ ok: true, applied: false, reason: 'STALE' })
      .mockRejectedValueOnce(new IntegrationError('Pelanggan belum ada', { code: 'PELANGGAN_TIDAK_ADA', retryable: false, httpStatus: 404 }));
    const { db, linkUpdates } = mockDb();
    const r = await runCustomerTaxProfilePushJob(db, { tenantId: 'buyer', payload: {} });
    expect(r).not.toHaveProperty('error');
    expect(linkUpdates[0].update.$set.taxProfileSync).toMatchObject({ status: 'OK', applied: false, reason: 'STALE' });
    expect(linkUpdates[1].update.$set.taxProfileSync).toMatchObject({ status: 'FAILED', code: 'PELANGGAN_TIDAK_ADA', retryable: false });
  });

  it('hanya vendor tertentu bila payload.vendorTenantId diisi', async () => {
    pushCustomerTaxProfile.mockResolvedValue({ ok: true });
    const { db } = mockDb();
    await runCustomerTaxProfilePushJob(db, { tenantId: 'buyer', payload: { vendorTenantId: 'vendor-b' } });
    expect(pushCustomerTaxProfile).toHaveBeenCalledTimes(1);
    expect(pushCustomerTaxProfile.mock.calls[0][0].body.vendorTenantId).toBe('vendor-b');
  });

  it('gagal bisnis (409 NPWP ganda) dicatat FAILED tanpa retry; gagal jaringan → job diulang', async () => {
    pushCustomerTaxProfile
      .mockRejectedValueOnce(new IntegrationError('NPWP sudah terdaftar', { code: 'NPWP_DUPLICATE', retryable: false, httpStatus: 409 }))
      .mockResolvedValueOnce({ ok: true });
    const { db, linkUpdates } = mockDb();
    const r = await runCustomerTaxProfilePushJob(db, { tenantId: 'buyer', payload: {} });
    expect(r).toMatchObject({ pushed: 1, failed: 1 });
    expect(r).not.toHaveProperty('error');
    expect(linkUpdates[0].update.$set.taxProfileSync).toMatchObject({ status: 'FAILED', code: 'NPWP_DUPLICATE' });
  });

  it('gagal jaringan → job mengembalikan error agar diulang', async () => {
    pushCustomerTaxProfile
      .mockRejectedValueOnce(new IntegrationError('timeout', { code: 'TIMEOUT', retryable: true }))
      .mockResolvedValueOnce({ ok: true });
    const r = await runCustomerTaxProfilePushJob(mockDb().db, { tenantId: 'buyer', payload: {} });
    expect(r).toMatchObject({ error: expect.stringContaining('vendor-a') });
  });
});

describe('ensureCustomerTaxProfileSynced', () => {
  beforeEach(() => enqueueJob.mockReset());
  const sync = (x: Record<string, unknown>) => ({ taxProfileSync: { profileUpdatedAt: STAMP.toISOString(), ...x } });

  it('antrekan bila belum pernah sinkron, versi lama, atau pelanggan belum ada', async () => {
    for (const link of [{}, { taxProfileSync: { status: 'OK', profileUpdatedAt: '2020-01-01T00:00:00.000Z' } }, sync({ status: 'FAILED', code: 'PELANGGAN_TIDAK_ADA', retryable: false })]) {
      expect(await ensureCustomerTaxProfileSynced(mockDb(link).db, 'buyer', 'vendor-a')).toBe(true);
    }
    expect(enqueueJob).toHaveBeenCalledTimes(3);
    expect(enqueueJob.mock.calls[0][1]).toMatchObject({ payload: { vendorTenantId: 'vendor-a' } });
  });

  it('lewati bila versi terkini sudah OK, gagal bisnis permanen, atau link tidak ada', async () => {
    expect(await ensureCustomerTaxProfileSynced(mockDb(sync({ status: 'OK' })).db, 'buyer', 'vendor-a')).toBe(false);
    expect(await ensureCustomerTaxProfileSynced(mockDb(sync({ status: 'FAILED', code: 'NPWP_DUPLICATE', retryable: false })).db, 'buyer', 'vendor-a')).toBe(false);
    expect(await ensureCustomerTaxProfileSynced(mockDb(null).db, 'buyer', 'vendor-a')).toBe(false);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
