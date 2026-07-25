import { describe, it, expect } from 'vitest';
import { restoreBatchesFromAllocations } from '@/lib/food-production/fefo-consume';

describe('W2-3 restoreBatchesFromAllocations', () => {
  it('increments qtyRemaining and revives CONSUMED → ACTIVE', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const batch = {
      id: 'b1',
      tenantId: 't1',
      batchNo: 'B-1',
      qty: 10,
      qtyRemaining: 0,
      status: 'CONSUMED',
      expiryDate: '2026-08-15',
    };
    const db = {
      collection: () => ({
        findOne: async () => batch,
        updateOne: async (_f: unknown, u: { $set: Record<string, unknown> }) => {
          updates.push(u.$set);
          Object.assign(batch, u.$set);
          return { modifiedCount: 1 };
        },
      }),
    };

    const result = await restoreBatchesFromAllocations(db as never, {
      tenantId: 't1',
      stokId: 'fg1',
      restores: [{ batchId: 'b1', batchNo: 'B-1', expiryDate: '2026-08-15', qty: 4 }],
      asOf: new Date('2026-07-25T12:00:00.000Z'),
      distributionId: 'dst1',
      noDokumen: 'DST-1',
    });

    expect(result.restored).toBe(4);
    expect(result.shortfall).toBe(0);
    expect(updates[0]).toMatchObject({
      qtyRemaining: 4,
      status: 'ACTIVE',
    });
  });

  it('marks EXPIRED when restored past expiry', async () => {
    const batch = {
      id: 'b2',
      tenantId: 't1',
      batchNo: 'B-2',
      qty: 10,
      qtyRemaining: 1,
      status: 'EXPIRED',
      expiryDate: '2026-07-01',
    };
    const db = {
      collection: () => ({
        findOne: async () => batch,
        updateOne: async (_f: unknown, u: { $set: Record<string, unknown> }) => {
          Object.assign(batch, u.$set);
          return { modifiedCount: 1 };
        },
      }),
    };

    const result = await restoreBatchesFromAllocations(db as never, {
      tenantId: 't1',
      stokId: 'fg1',
      restores: [{ batchId: 'b2', expiryDate: '2026-07-01', qty: 2 }],
      asOf: new Date('2026-07-25T12:00:00.000Z'),
    });

    expect(result.restored).toBe(2);
    expect(batch.status).toBe('EXPIRED');
    expect(batch.qtyRemaining).toBe(3);
  });
});
