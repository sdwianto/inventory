import { describe, it, expect, vi } from 'vitest';
import { runIntegrationReconcile } from '@/lib/api/integration-reconcile-run';

vi.mock('@/lib/api/bg-jobs', () => ({
  enqueueJob: vi.fn().mockResolvedValue({ jobId: 'j1', reused: false }),
  scheduleJobProcessing: vi.fn(),
  JOB_TYPES: { GRN_INVOICE_SYNC: 'GRN_INVOICE_SYNC' },
}));

describe('runIntegrationReconcile', () => {
  it('detects CPO without vendor SO and persists totalMismatch', async () => {
    let inserted: Record<string, unknown> | null = null;
    const db = {
      collection: (name: string) => {
        if (name === 'customer_purchase_orders') {
          return {
            find: (filter: Record<string, unknown>) => ({
              project: () => ({
                limit: () => ({
                  toArray: async () => {
                    if (filter.$or) {
                      return [{ id: 'cpo-1', noPO: 'CPO-001', status: 'CONFIRMED' }];
                    }
                    return [];
                  },
                }),
              }),
            }),
          };
        }
        if (name === 'goods_receipts') {
          return {
            find: () => ({
              project: () => ({
                limit: () => ({
                  toArray: async () => [],
                }),
              }),
            }),
          };
        }
        if (name === 'hutang') {
          return {
            find: () => ({
              project: () => ({
                limit: () => ({
                  toArray: async () => [],
                }),
              }),
            }),
          };
        }
        if (name === 'integration_reconcile_reports') {
          return {
            insertOne: async (doc: Record<string, unknown>) => {
              inserted = doc;
            },
          };
        }
        return {};
      },
    };

    const diff = await runIntegrationReconcile(db as never, 'sppg');
    expect(diff.cpoWithoutVendorSo).toHaveLength(1);
    expect(diff.cpoWithoutVendorSo[0].noPO).toBe('CPO-001');
    expect(diff.autoFixEnqueued).toBe(0);
    expect(inserted).toMatchObject({
      summary: {
        cpoWithoutSo: 1,
        totalMismatch: 1,
      },
    });
  });

  it('enqueues GRN invoice sync for stale posted GRNs', async () => {
    const { enqueueJob } = await import('@/lib/api/bg-jobs');
    vi.mocked(enqueueJob).mockClear();

    const db = {
      collection: (name: string) => {
        if (name === 'customer_purchase_orders') {
          return {
            find: () => ({
              project: () => ({
                limit: () => ({
                  toArray: async () => [],
                }),
              }),
            }),
          };
        }
        if (name === 'goods_receipts') {
          return {
            find: (filter: Record<string, unknown>) => ({
              project: () => ({
                limit: () => ({
                  toArray: async () => {
                    const or = filter.$or as Array<Record<string, unknown>> | undefined;
                    if (or?.some((clause) => clause.invoiceSyncStatus)) {
                      return [{
                        id: 'grn-1',
                        noGRN: 'GRN-001',
                        noDO: 'DO-001',
                        invoiceSyncStatus: 'FAILED',
                        postedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
                        tenantId: 'sppg',
                      }];
                    }
                    return [];
                  },
                }),
              }),
            }),
          };
        }
        if (name === 'hutang') {
          return {
            find: () => ({
              project: () => ({
                limit: () => ({
                  toArray: async () => [],
                }),
              }),
            }),
          };
        }
        if (name === 'integration_reconcile_reports') {
          return { insertOne: async () => {} };
        }
        return {};
      },
    };

    const diff = await runIntegrationReconcile(db as never, 'sppg');
    expect(diff.grnInvoiceNotDone).toHaveLength(1);
    expect(diff.autoFixEnqueued).toBe(1);
    expect(enqueueJob).toHaveBeenCalled();
  });
});
