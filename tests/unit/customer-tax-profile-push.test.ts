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
vi.mock('@/lib/api/bg-jobs', () => ({
  JOB_TYPES: { CUSTOMER_TAX_PROFILE_PUSH: 'customer_tax_profile_push' },
  enqueueJob: vi.fn(),
  scheduleJobProcessing: vi.fn(),
}));

import { runCustomerTaxProfilePushJob } from '@/lib/api/customer-tax-profile-push';

const STAMP = new Date('2026-10-03T01:00:00.000Z');

function mockDb() {
  const linkUpdates: Array<{ filter: unknown; update: { $set: { taxProfileSync: Record<string, unknown> } } }> = [];
  const db = {
    collection: (name: string) => ({
      findOne: async () => (name === 'tenant_settings'
        ? { companyNPWP: '01.234.567.8-901.000', companyAddress: ' Jl. Pembeli 1 ', tax: { pkp: true }, taxProfileUpdatedAt: STAMP }
        : null),
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
