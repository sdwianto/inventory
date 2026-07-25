import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('uuid', () => ({ v4: () => 'clone-lot-uuid-1' }));

import { relocateLotsFefo } from '@/lib/food-production/transfer-lot-fefo';

type Lot = {
  id: string;
  lotNo: string;
  tenantId: string;
  productId: string;
  warehouseKode: string;
  expiryDate: string;
  status: string;
  qty: number;
  qtyRemaining: number;
  grnId: string;
  receivedAt: string;
};

function makeDb(lots: Lot[]) {
  const store = lots.map((b) => ({ ...b }));
  const updateOne = vi.fn(async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
    const row = store.find((b) => b.id === filter.id);
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    if (filter.warehouseKode && row.warehouseKode !== filter.warehouseKode) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    Object.assign(row, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  });
  const insertOne = vi.fn(async (doc: Lot) => {
    store.push({ ...doc });
    return { insertedId: doc.id };
  });
  const findOne = vi.fn(async (filter: Record<string, unknown>) => {
    return (
      store.find((b) => {
        if (filter.id && b.id !== filter.id) return false;
        if (filter.tenantId && b.tenantId !== filter.tenantId) return false;
        if (filter.lotNo && b.lotNo !== filter.lotNo) return false;
        if (filter.productId && b.productId !== filter.productId) return false;
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
          b.productId === 'p1' &&
          b.warehouseKode === 'WH-A' &&
          ['ACTIVE', 'EXPIRED'].includes(b.status),
      ),
  };

  return {
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
}

describe('W2-13 relocateLotsFefo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('full relocate updates warehouseKode on same lot id', async () => {
    const db = makeDb([
      {
        id: 'l1',
        lotNo: 'L-1',
        tenantId: 't1',
        productId: 'p1',
        warehouseKode: 'WH-A',
        expiryDate: '2026-08-01',
        status: 'ACTIVE',
        qty: 10,
        qtyRemaining: 10,
        grnId: 'g1',
        receivedAt: '2026-07-20',
      },
    ]);

    const result = await relocateLotsFefo(db as never, {
      tenantId: 't1',
      stokId: 'p1',
      fromWarehouseKode: 'WH-A',
      toWarehouseKode: 'WH-B',
      needQty: 10,
      transferId: 'tr1',
    });

    expect(result.skippedNoLots).toBe(false);
    expect(result.allocated).toBe(10);
    expect(db._store[0]?.warehouseKode).toBe('WH-B');
    expect(db._insertOne).not.toHaveBeenCalled();
  });

  it('partial relocate decrements source and clones dest', async () => {
    const db = makeDb([
      {
        id: 'l1',
        lotNo: 'L-1',
        tenantId: 't1',
        productId: 'p1',
        warehouseKode: 'WH-A',
        expiryDate: '2026-08-01',
        status: 'ACTIVE',
        qty: 10,
        qtyRemaining: 10,
        grnId: 'g1',
        receivedAt: '2026-07-20',
      },
    ]);

    const result = await relocateLotsFefo(db as never, {
      tenantId: 't1',
      stokId: 'p1',
      fromWarehouseKode: 'WH-A',
      toWarehouseKode: 'WH-B',
      needQty: 4,
    });

    expect(result.allocated).toBe(4);
    expect(db._store[0]?.qtyRemaining).toBe(6);
    expect(db._store[0]?.warehouseKode).toBe('WH-A');
    expect(db._insertOne).toHaveBeenCalledTimes(1);
    const clone = db._store.find((b) => b.id === 'clone-lot-uuid-1');
    expect(clone?.warehouseKode).toBe('WH-B');
    expect(clone?.qtyRemaining).toBe(4);
    expect((clone as { relocatedFromLotId?: string })?.relocatedFromLotId).toBe('l1');
  });

  it('soft-skips when no lots at source', async () => {
    const db = makeDb([]);
    const result = await relocateLotsFefo(db as never, {
      tenantId: 't1',
      stokId: 'p1',
      fromWarehouseKode: 'WH-A',
      toWarehouseKode: 'WH-B',
      needQty: 5,
    });
    expect(result.skippedNoLots).toBe(true);
    expect(result.allocated).toBe(0);
    expect(result.shortfall).toBe(5);
  });
});
