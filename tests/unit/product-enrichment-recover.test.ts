/**
 * PRODUCT_ENRICHMENT_SYNC recovery lists PENDING/FAILED outbox.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { INTEGRATION_OUTBOX_TYPES } from '@/lib/api/integration-outbox';

const drainEnsureProductEnrichment = vi.hoisted(() => vi.fn());
const enqueueJob = vi.hoisted(() => vi.fn(async () => ({ jobId: 'j1' })));
const scheduleJobProcessing = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/product-enrichment-outbox', () => ({
  drainEnsureProductEnrichment: (...args: unknown[]) => drainEnsureProductEnrichment(...args),
}));

vi.mock('@/lib/api/bg-jobs', () => ({
  JOB_TYPES: { PRODUCT_ENRICHMENT_SYNC: 'PRODUCT_ENRICHMENT_SYNC' },
  enqueueJob: (...args: unknown[]) => enqueueJob(...args),
  scheduleJobProcessing: (...args: unknown[]) => scheduleJobProcessing(...args),
}));

vi.mock('@/lib/api/tenant-scope', () => ({
  normalizeTenantId: (t: string) => String(t || 'default').toLowerCase(),
}));

import {
  listPendingProductEnrichmentOutbox,
  sweepPendingProductEnrichment,
} from '@/lib/api/product-enrichment-recover';

function mockDb(rows: Record<string, unknown>[]) {
  return {
    collection(name: string) {
      if (name !== 'integration_outbox') {
        return { find: () => ({ sort: () => ({ limit: () => ({ project: () => ({ toArray: async () => [] }) }) }) }) };
      }
      return {
        find: () => ({
          sort: () => ({
            limit: () => ({
              project: () => ({
                toArray: async () => rows,
              }),
            }),
          }),
        }),
      };
    },
  };
}

describe('product enrichment recovery', () => {
  beforeEach(() => {
    drainEnsureProductEnrichment.mockReset();
    enqueueJob.mockClear();
    scheduleJobProcessing.mockClear();
  });

  it('lists PENDING/FAILED enrichment outbox', async () => {
    const db = mockDb([
      {
        aggregateId: 'p1',
        tenantId: 'sppg',
        status: 'FAILED',
        payload: { vendorTenantId: 'puspita' },
        type: INTEGRATION_OUTBOX_TYPES.ENSURE_PRODUCT_ENRICHMENT,
      },
    ]);
    const rows = await listPendingProductEnrichmentOutbox(db as never);
    expect(rows).toHaveLength(1);
    expect(rows[0].aggregateId).toBe('p1');
  });

  it('sweep drains ok rows without enqueue', async () => {
    drainEnsureProductEnrichment.mockResolvedValue({ ok: true, outboxId: 'o1' });
    const db = mockDb([
      {
        aggregateId: 'p1',
        tenantId: 'sppg',
        status: 'PENDING',
        payload: { vendorTenantId: 'puspita', vendorStokId: 's1' },
      },
    ]);
    const r = await sweepPendingProductEnrichment(db as never, { limit: 10 });
    expect(r.drainedInline).toBe(1);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('sweep enqueues when drain fails', async () => {
    drainEnsureProductEnrichment.mockResolvedValue({ ok: false, error: 'peer down', outboxId: 'o1' });
    const db = mockDb([
      {
        aggregateId: 'p1',
        tenantId: 'sppg',
        status: 'FAILED',
        payload: { vendorTenantId: 'puspita' },
      },
    ]);
    const r = await sweepPendingProductEnrichment(db as never, { limit: 10 });
    expect(r.enqueued).toBe(1);
    expect(enqueueJob).toHaveBeenCalled();
  });
});
