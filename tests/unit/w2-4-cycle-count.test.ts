import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncBatchesOnVariance } from '@/lib/food-production/cycle-count-fefo';
import { repairFefoBatchMismatches } from '@/lib/api/fefo-batch-reconcile';

const consumeBatchesFefo = vi.fn();

vi.mock('@/lib/food-production/fefo-consume', () => ({
  consumeBatchesFefo: (...args: unknown[]) => consumeBatchesFefo(...args),
}));

vi.mock('@/lib/api/stok-lokasi', () => ({
  getQtyStokLokasi: vi.fn(async () => 5),
}));

describe('W2-4 syncBatchesOnVariance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('count down calls FEFO consume with allowExpired', async () => {
    consumeBatchesFefo.mockResolvedValue({
      stokId: 'fg1',
      needQty: 3,
      allocated: 3,
      shortfall: 0,
      allocations: [],
      skippedNoBatches: false,
    });
    const result = await syncBatchesOnVariance({} as never, {
      tenantId: 't1',
      stokId: 'fg1',
      warehouseKode: 'GKERING',
      deltaQty: -3,
      noDokumen: 'PS-1',
    });
    expect(consumeBatchesFefo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        needQty: 3,
        allowExpired: true,
        stokId: 'fg1',
      }),
      undefined,
    );
    expect(result.consumed).toBe(3);
    expect(result.skippedNoBatches).toBe(false);
  });

  it('count up increases newest batch qtyRemaining', async () => {
    const batch = {
      id: 'b1',
      tenantId: 't1',
      qty: 10,
      qtyRemaining: 2,
      status: 'ACTIVE',
      expiryDate: '2026-08-20',
      finishedGoodProductId: 'fg1',
      warehouseKode: 'GKERING',
    };
    const updates: Array<Record<string, unknown>> = [];
    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => [batch],
    };
    const db = {
      collection: () => ({
        find: () => findCursor,
        updateOne: async (_f: unknown, u: { $set: Record<string, unknown> }) => {
          updates.push(u.$set);
          return { modifiedCount: 1 };
        },
      }),
    };

    const result = await syncBatchesOnVariance(db as never, {
      tenantId: 't1',
      stokId: 'fg1',
      warehouseKode: 'GKERING',
      deltaQty: 4,
      asOf: new Date('2026-07-25T12:00:00.000Z'),
      noDokumen: 'PS-2',
    });

    expect(result.increased).toBe(4);
    expect(updates[0]).toMatchObject({
      qtyRemaining: 6,
      status: 'ACTIVE',
    });
  });

  it('zero delta is no-op', async () => {
    const result = await syncBatchesOnVariance({} as never, {
      tenantId: 't1',
      stokId: 'fg1',
      warehouseKode: 'GKERING',
      deltaQty: 0,
    });
    expect(result.skippedNoBatches).toBe(true);
    expect(consumeBatchesFefo).not.toHaveBeenCalled();
  });
});

describe('W2-4 repairFefoBatchMismatches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks ACTIVE_PAST_EXPIRY and consumes BATCH_VS_STOK excess', async () => {
    consumeBatchesFefo.mockResolvedValue({
      allocated: 6,
      shortfall: 0,
      skippedNoBatches: false,
      allocations: [],
      needQty: 6,
      stokId: 'fg1',
    });

    const batches = [
      {
        id: 'b-exp',
        batchNo: 'B-EXP',
        tenantId: 't1',
        expiryDate: '2026-07-01',
        status: 'ACTIVE',
        qty: 5,
        qtyRemaining: 5,
        finishedGoodProductId: 'fg1',
        warehouseKode: 'GKERING',
      },
      {
        id: 'b-ok',
        batchNo: 'B-OK',
        tenantId: 't1',
        expiryDate: '2026-08-10',
        status: 'ACTIVE',
        qty: 10,
        qtyRemaining: 10,
        finishedGoodProductId: 'fg1',
        warehouseKode: 'GKERING',
      },
    ];

    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => batches,
    };
    const updateOne = vi.fn(async () => ({ modifiedCount: 1 }));
    const insertOne = vi.fn(async () => ({ insertedId: 'x' }));
    const db = {
      collection: (name: string) => {
        if (name === 'production_batches') {
          return { find: () => findCursor, updateOne };
        }
        if (name === 'fefo_batch_reconcile_reports') {
          return { insertOne };
        }
        return { find: () => findCursor, updateOne, insertOne };
      },
    };

    const result = await repairFefoBatchMismatches(db as never, 't1');
    expect(result.repaired).toBeGreaterThanOrEqual(1);
    expect(result.actions.some((a) => a.kind === 'ACTIVE_PAST_EXPIRY')).toBe(true);
    // sum remaining after detect includes expired ACTIVE; stock mock=5 → excess consume
    expect(consumeBatchesFefo).toHaveBeenCalled();
    expect(insertOne).toHaveBeenCalled();
  });
});
