import { describe, it, expect, vi, beforeEach } from 'vitest';
import { consumeIngredientLotsFefo } from '@/lib/food-production/ingredient-lot-consume';
import { allocateFefo } from '@/lib/food-production/fefo-allocate';

describe('W2-6 allocateFefo on ingredient lot candidates', () => {
  it('takes earliest expiry first', () => {
    const plan = allocateFefo(
      8,
      [
        { id: 'late', batchNo: 'L-LATE', expiryDate: '2026-09-01', qtyRemaining: 20 },
        { id: 'early', batchNo: 'L-EARLY', expiryDate: '2026-08-01', qtyRemaining: 5 },
      ],
      { asOf: new Date('2026-07-25T12:00:00.000Z') },
    );
    expect(plan.allocations).toEqual([
      { batchId: 'early', batchNo: 'L-EARLY', expiryDate: '2026-08-01', qty: 5 },
      { batchId: 'late', batchNo: 'L-LATE', expiryDate: '2026-09-01', qty: 3 },
    ]);
  });
});

describe('W2-6 consumeIngredientLotsFefo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when no lots exist', async () => {
    const findCursor = {
      sort: () => findCursor,
      toArray: async () => [],
    };
    const db = {
      collection: () => ({ find: () => findCursor }),
    };
    const result = await consumeIngredientLotsFefo(db as never, {
      tenantId: 't1',
      stokId: 'p1',
      warehouseKode: 'GKERING',
      needQty: 5,
    });
    expect(result.skippedNoLots).toBe(true);
    expect(result.allocated).toBe(0);
  });

  it('consumes FEFO and marks CONSUMED at zero', async () => {
    const lots = [
      {
        id: 'l1',
        lotNo: 'L-1',
        tenantId: 't1',
        productId: 'p1',
        warehouseKode: 'GKERING',
        expiryDate: '2026-08-01',
        qty: 5,
        qtyRemaining: 5,
        status: 'ACTIVE',
      },
      {
        id: 'l2',
        lotNo: 'L-2',
        tenantId: 't1',
        productId: 'p1',
        warehouseKode: 'GKERING',
        expiryDate: '2026-09-01',
        qty: 10,
        qtyRemaining: 10,
        status: 'ACTIVE',
      },
    ];
    const updates: Array<{ id: string; set: Record<string, unknown> }> = [];
    const findCursor = {
      sort: () => findCursor,
      toArray: async () => lots,
    };
    const db = {
      collection: () => ({
        find: () => findCursor,
        updateOne: async (f: { id: string }, u: { $set: Record<string, unknown> }) => {
          updates.push({ id: f.id, set: u.$set });
          const lot = lots.find((l) => l.id === f.id);
          if (lot) Object.assign(lot, u.$set);
          return { modifiedCount: 1 };
        },
      }),
    };

    const result = await consumeIngredientLotsFefo(db as never, {
      tenantId: 't1',
      stokId: 'p1',
      warehouseKode: 'GKERING',
      needQty: 7,
      asOf: new Date('2026-07-25T12:00:00.000Z'),
      issueId: 'iss1',
      noDokumen: 'PBL-1',
    });

    expect(result.skippedNoLots).toBe(false);
    expect(result.allocated).toBe(7);
    expect(result.shortfall).toBe(0);
    expect(updates[0]).toMatchObject({
      id: 'l1',
      set: { qtyRemaining: 0, status: 'CONSUMED' },
    });
    expect(updates[1]).toMatchObject({
      id: 'l2',
      set: { qtyRemaining: 8, status: 'ACTIVE' },
    });
  });
});
