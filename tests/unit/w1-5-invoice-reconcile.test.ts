/**
 * W1-5 slice 1: Invoice Detect→Compare→Repair template wiring + Ops surface.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleOpsDashboard } from '@/lib/api/handlers/ops-dashboard';

vi.mock('@/lib/api/health', () => ({
  buildHealthResponse: vi.fn().mockResolvedValue({ status: 'ok', checks: {} }),
}));

vi.mock('@/lib/api/request-metrics', () => ({
  getFpLatencySnapshots: vi.fn().mockReturnValue([]),
  getFpRecentFailures: vi.fn().mockReturnValue([]),
  getFpHotpathSlo: vi.fn().mockReturnValue({ sampleCount: 0, p95Ms: 0, thresholdMs: 500, ok: true }),
}));

const enqueueJob = vi.fn();
const scheduleJobProcessing = vi.fn();

vi.mock('@/lib/api/bg-jobs', () => ({
  enqueueJob: (...args: unknown[]) => enqueueJob(...args),
  scheduleJobProcessing: (...args: unknown[]) => scheduleJobProcessing(...args),
  JOB_TYPES: { INTEGRATION_RECONCILE: 'INTEGRATION_RECONCILE' },
}));

const masterAuth = {
  role: 'MASTER',
  tenantId: 't1',
  userId: 'u1',
  email: 'm@x.com',
  name: 'M',
  isMaster: true,
};

describe('W1-5 Invoice reconciliation template', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueJob.mockResolvedValue({ jobId: 'job-rec-1', reused: false });
  });

  it('wires Detect / Compare / Repair modules', () => {
    const detect = readFileSync(
      join(process.cwd(), 'lib/api/integration-reconcile-run.ts'),
      'utf8',
    );
    const compare = readFileSync(
      join(process.cwd(), 'lib/api/grn-invoice-reconcile.ts'),
      'utf8',
    );
    expect(detect).toMatch(/runIntegrationReconcile/);
    expect(detect).toMatch(/grnInvoiceNotDone/);
    expect(detect).toMatch(/integration_reconcile_reports/);
    expect(detect).toMatch(/GRN_INVOICE_SYNC/);
    expect(compare).toMatch(/reconcileGrnInvoiceFromSales/);
    expect(compare).toMatch(/fetchPostedInvoicesFromSalesVendor/);
    expect(compare).toMatch(/createHutangFromVendorInvoice/);
  });

  it('ops POST /ops/invoice-reconcile/run enqueues INTEGRATION_RECONCILE for MASTER', async () => {
    const res = await handleOpsDashboard({
      db: {} as never,
      route: '/ops/invoice-reconcile/run',
      method: 'POST',
      path: ['ops', 'invoice-reconcile', 'run'],
      body: {},
      auth: masterAuth,
      request: new Request('http://local/api/ops/invoice-reconcile/run', { method: 'POST' }),
      url: new URL('http://local/api/ops/invoice-reconcile/run'),
    } as never);

    expect(res?.status).toBe(200);
    expect(enqueueJob).toHaveBeenCalled();
    const json = await res?.json();
    expect(json).toMatchObject({
      enqueued: true,
      type: 'INTEGRATION_RECONCILE',
      jobId: 'job-rec-1',
    });
  });

  it('ops GET /ops/dashboard includes invoiceReconcile from latest report', async () => {
    const emptyCursor = {
      sort() { return this; },
      limit() { return this; },
      project() { return this; },
      toArray: async () => [],
    };
    const db = {
      collection(name: string) {
        if (name === 'integration_reconcile_reports') {
          return {
            find: () => ({
              sort: () => ({
                limit: () => ({
                  project: () => ({
                    toArray: async () => [
                      {
                        id: 'rep-1',
                        tenantId: 'system',
                        createdAt: new Date('2026-07-25T00:00:00Z'),
                        summary: {
                          totalMismatch: 2,
                          grnStale: 2,
                          autoFixEnqueued: 1,
                        },
                        diff: {
                          autoFixEnqueued: 1,
                          grnInvoiceNotDone: [{ id: 'g1', noGRN: 'GRN-1', noDO: 'DO-1' }],
                        },
                      },
                    ],
                  }),
                }),
              }),
            }),
          };
        }
        return { find: () => emptyCursor };
      },
    };

    const res = await handleOpsDashboard({
      db: db as never,
      route: '/ops/dashboard',
      method: 'GET',
      path: ['ops', 'dashboard'],
      body: null,
      auth: masterAuth,
      request: new Request('http://local/api/ops/dashboard'),
      url: new URL('http://local/api/ops/dashboard'),
    } as never);

    expect(res?.status).toBe(200);
    const json = await res?.json();
    expect(json.invoiceReconcile).toMatchObject({
      reportId: 'rep-1',
      totalMismatch: 2,
      grnStale: 2,
      autoFixEnqueued: 1,
    });
    expect(json.invoiceReconcile.grnInvoiceNotDoneSample).toHaveLength(1);
  });

  it('rejects non-MASTER enqueue', async () => {
    const res = await handleOpsDashboard({
      db: {} as never,
      route: '/ops/invoice-reconcile/run',
      method: 'POST',
      path: ['ops', 'invoice-reconcile', 'run'],
      body: {},
      auth: { ...masterAuth, role: 'ADMIN', isMaster: false },
      request: new Request('http://local/api/ops/invoice-reconcile/run', { method: 'POST' }),
      url: new URL('http://local/api/ops/invoice-reconcile/run'),
    } as never);
    expect(res?.status).toBe(403);
  });
});
