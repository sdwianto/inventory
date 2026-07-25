import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('uuid', () => ({ v4: () => 'clone-batch-uuid-1' }));

import { relocateBatchesFefo } from '@/lib/food-production/transfer-fefo';

type Batch = {
  id: string;
  batchNo: string;
  tenantId: string;
  finishedGoodProductId: string;
  warehouseKode: string;
  expiryDate: string;
  status: string;
  qty: number;
  qtyRemaining: number;
  productionResultId: string;
  productionResultNo: string;
  productionPlanId: string;
  kitchenId: string;
  producedAt: string;
};

function makeDb(batches: Batch[]) {
  const store = batches.map((b) => ({ ...b }));
  const updateOne = vi.fn(async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
    const row = store.find((b) => b.id === filter.id);
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    if (filter.warehouseKode && row.warehouseKode !== filter.warehouseKode) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    Object.assign(row, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  });
  const insertOne = vi.fn(async (doc: Batch) => {
    store.push({ ...doc });
    return { insertedId: doc.id };
  });
  const findOne = vi.fn(async (filter: Record<string, unknown>) => {
    return (
      store.find((b) => {
        if (filter.id && b.id !== filter.id) return false;
        if (filter.tenantId && b.tenantId !== filter.tenantId) return false;
        if (filter.batchNo && b.batchNo !== filter.batchNo) return false;
        if (filter.finishedGoodProductId && b.finishedGoodProductId !== filter.finishedGoodProductId) {
          return false;
        }
        if (filter.warehouseKode && b.warehouseKode !== filter.warehouseKode) return false;
        const statusIn = (filter.status as { $in?: string[] } | undefined)?.$in;
        if (statusIn && !statusIn.includes(b.status)) return false;
        return true;
      }) || null
    );
  });

  const findCursor = {
    sort: () => findCursor,
    toArray: async () =>
      store.filter(
        (b) =>
          b.tenantId === 't1' &&
          b.finishedGoodProductId === 'fg1' &&
          b.warehouseKode === 'WH-A' &&
          ['ACTIVE', 'EXPIRED'].includes(b.status),
      ),
  };

  const db = {
    collection: () => ({
      find: () => findCursor,
      findOne,
      updateOne,
      insertOne,
    }),
    _store: store,
    _updateOne: updateOne,
    _insertOne: insertOne,
  };
  return db;
}

describe('W2-12 relocateBatchesFefo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('full relocate updates warehouseKode on same batch id', async () => {
    const db = makeDb([
      {
        id: 'b1',
        batchNo: 'B-1',
        tenantId: 't1',
        finishedGoodProductId: 'fg1',
        warehouseKode: 'WH-A',
        expiryDate: '2026-08-01',
        status: 'ACTIVE',
        qty: 10,
        qtyRemaining: 10,
        productionResultId: 'hsl1',
        productionResultNo: 'HSL-1',
        productionPlanId: 'plan1',
        kitchenId: 'k1',
        producedAt: '2026-07-25',
      },
    ]);

    const result = await relocateBatchesFefo(db as never, {
      tenantId: 't1',
      stokId: 'fg1',
      fromWarehouseKode: 'WH-A',
      toWarehouseKode: 'WH-B',
      needQty: 10,
      transferId: 'tr1',
      noTransaksi: 'TR-1',
    });

    expect(result.skippedNoBatches).toBe(false);
    expect(result.allocated).toBe(10);
    expect(result.shortfall).toBe(0);
    expect(db._store[0]?.warehouseKode).toBe('WH-B');
    expect(db._store[0]?.id).toBe('b1');
    expect(db._insertOne).not.toHaveBeenCalled();
  });

  it('partial relocate decrements source and clones dest', async () => {
    const db = makeDb([
      {
        id: 'b1',
        batchNo: 'B-1',
        tenantId: 't1',
        finishedGoodProductId: 'fg1',
        warehouseKode: 'WH-A',
        expiryDate: '2026-08-01',
        status: 'ACTIVE',
        qty: 10,
        qtyRemaining: 10,
        productionResultId: 'hsl1',
        productionResultNo: 'HSL-1',
        productionPlanId: 'plan1',
        kitchenId: 'k1',
        producedAt: '2026-07-25',
      },
    ]);

    const result = await relocateBatchesFefo(db as never, {
      tenantId: 't1',
      stokId: 'fg1',
      fromWarehouseKode: 'WH-A',
      toWarehouseKode: 'WH-B',
      needQty: 4,
    });

    expect(result.allocated).toBe(4);
    expect(db._store[0]?.qtyRemaining).toBe(6);
    expect(db._store[0]?.warehouseKode).toBe('WH-A');
    expect(db._insertOne).toHaveBeenCalledTimes(1);
    const clone = db._store.find((b) => b.id === 'clone-batch-uuid-1');
    expect(clone?.warehouseKode).toBe('WH-B');
    expect(clone?.qtyRemaining).toBe(4);
    expect((clone as { relocatedFromBatchId?: string })?.relocatedFromBatchId).toBe('b1');
  });

  it('soft-skips when no batches at source', async () => {
    const db = makeDb([]);
    const result = await relocateBatchesFefo(db as never, {
      tenantId: 't1',
      stokId: 'fg1',
      fromWarehouseKode: 'WH-A',
      toWarehouseKode: 'WH-B',
      needQty: 5,
    });
    expect(result.skippedNoBatches).toBe(true);
    expect(result.allocated).toBe(0);
    expect(result.shortfall).toBe(5);
  });

  it('no-ops when from === to', async () => {
    const db = makeDb([
      {
        id: 'b1',
        batchNo: 'B-1',
        tenantId: 't1',
        finishedGoodProductId: 'fg1',
        warehouseKode: 'WH-A',
        expiryDate: '2026-08-01',
        status: 'ACTIVE',
        qty: 10,
        qtyRemaining: 10,
        productionResultId: 'hsl1',
        productionResultNo: 'HSL-1',
        productionPlanId: 'plan1',
        kitchenId: 'k1',
        producedAt: '2026-07-25',
      },
    ]);
    const result = await relocateBatchesFefo(db as never, {
      tenantId: 't1',
      stokId: 'fg1',
      fromWarehouseKode: 'WH-A',
      toWarehouseKode: 'WH-A',
      needQty: 5,
    });
    expect(result.skippedNoBatches).toBe(true);
    expect(result.allocated).toBe(0);
    expect(db._updateOne).not.toHaveBeenCalled();
  });
});
