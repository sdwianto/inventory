/**
 * ENSURE_PRODUCT_ENRICHMENT — reopen DONE + drain ke Sales.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { INTEGRATION_OUTBOX_TYPES } from '@/lib/api/integration-outbox';
import {
  drainEnsureProductEnrichment,
  ensureProductEnrichmentOutboxPending,
} from '@/lib/api/product-enrichment-outbox';

const pushProductEnrichmentToSales = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/product-enrichment-push', () => ({
  pushProductEnrichmentToSales: (...args: unknown[]) => pushProductEnrichmentToSales(...args),
}));

vi.mock('@/lib/api/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createOutboxMockDb() {
  const docs: Record<string, unknown>[] = [];
  return {
    docs,
    collection(name: string) {
      if (name !== 'integration_outbox') {
        return {
          findOne: vi.fn().mockResolvedValue(null),
          insertOne: vi.fn(),
          updateOne: vi.fn(),
          findOneAndUpdate: vi.fn(),
        };
      }
      return {
        insertOne: async (doc: Record<string, unknown>) => {
          docs.push({ ...doc });
          return { insertedId: doc.id };
        },
        findOne: async (filter: Record<string, unknown>) => {
          return docs.find((d) => {
            if (filter.id && d.id !== filter.id) return false;
            if (filter.type && d.type !== filter.type) return false;
            if (filter.aggregateId && d.aggregateId !== filter.aggregateId) return false;
            return true;
          }) || null;
        },
        findOneAndUpdate: async (
          filter: Record<string, unknown>,
          update: { $set?: Record<string, unknown>; $inc?: Record<string, number> },
        ) => {
          const idx = docs.findIndex((d) => {
            if (filter.type && d.type !== filter.type) return false;
            if (filter.aggregateId && d.aggregateId !== filter.aggregateId) return false;
            const status = String(d.status || '');
            return status === 'PENDING' || status === 'FAILED';
          });
          if (idx < 0) return null;
          const next = {
            ...docs[idx],
            ...(update.$set || {}),
            attempts: Number(docs[idx].attempts || 0) + (update.$inc?.attempts || 0),
          };
          docs[idx] = next;
          return next;
        },
        updateOne: async (
          filter: { id: string; status?: string; claimToken?: string },
          update: { $set?: Record<string, unknown>; $unset?: Record<string, string> },
        ) => {
          const idx = docs.findIndex((d) => d.id === filter.id);
          if (idx < 0) return { matchedCount: 0 };
          if (filter.status && docs[idx].status !== filter.status) {
            return { matchedCount: 0 };
          }
          if (filter.claimToken && docs[idx].claimToken !== filter.claimToken) {
            return { matchedCount: 0 };
          }
          docs[idx] = { ...docs[idx], ...(update.$set || {}) };
          if (update.$unset) {
            for (const k of Object.keys(update.$unset)) {
              const next = { ...docs[idx] };
              delete next[k];
              docs[idx] = next;
            }
          }
          return { matchedCount: 1 };
        },
      };
    },
  };
}

describe('ENSURE_PRODUCT_ENRICHMENT', () => {
  beforeEach(() => {
    pushProductEnrichmentToSales.mockReset();
    pushProductEnrichmentToSales.mockResolvedValue({ ok: true });
  });

  it('reopens DONE on new ensure', async () => {
    const db = createOutboxMockDb();
    await ensureProductEnrichmentOutboxPending(db as never, {
      tenantId: 'sppg',
      productId: 'local-1',
      vendorTenantId: 'puspita',
      vendorStokId: 'sales-1',
      detailProduk: 'v1',
      fotos: [],
    });
    db.docs[0].status = 'DONE';

    await ensureProductEnrichmentOutboxPending(db as never, {
      tenantId: 'sppg',
      productId: 'local-1',
      vendorTenantId: 'puspita',
      vendorStokId: 'sales-1',
      detailProduk: 'v2',
      fotos: ['https://x/a.jpg'],
    });

    expect(db.docs[0].status).toBe('PENDING');
    expect((db.docs[0].payload as { detailProduk: string }).detailProduk).toBe('v2');
    expect(db.docs[0].type).toBe(INTEGRATION_OUTBOX_TYPES.ENSURE_PRODUCT_ENRICHMENT);
  });

  it('drain succeeds', async () => {
    const db = createOutboxMockDb();
    const r = await drainEnsureProductEnrichment(db as never, {
      tenantId: 'sppg',
      productId: 'local-1',
      vendorTenantId: 'puspita',
      vendorStokId: 'sales-1',
      kode: 'B998100',
      detailProduk: 'desk',
      fotos: [],
    });
    expect(r.ok).toBe(true);
    expect(pushProductEnrichmentToSales).toHaveBeenCalled();
    expect(db.docs[0].status).toBe('DONE');
  });
});
