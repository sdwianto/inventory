import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncLotsOnVariance } from '@/lib/food-production/cycle-count-ingredient-lots';

const consumeIngredientLotsFefo = vi.fn();

vi.mock('@/lib/food-production/ingredient-lot-consume', () => ({
  consumeIngredientLotsFefo: (...args: unknown[]) => consumeIngredientLotsFefo(...args),
}));

describe('W2-8 syncLotsOnVariance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('count down calls FEFO lot consume with allowExpired', async () => {
    consumeIngredientLotsFefo.mockResolvedValue({
      allocated: 4,
      shortfall: 0,
      skippedNoLots: false,
      needQty: 4,
      stokId: 'p1',
      warehouseKode: 'GKERING',
      allocations: [],
    });
    const result = await syncLotsOnVariance({} as never, {
      tenantId: 't1',
      stokId: 'p1',
      warehouseKode: 'GKERING',
      deltaQty: -4,
      noDokumen: 'PS-1',
    });
    expect(consumeIngredientLotsFefo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ needQty: 4, allowExpired: true }),
      undefined,
    );
    expect(result.consumed).toBe(4);
    expect(result.skippedNoLots).toBe(false);
  });

  it('count up increases newest lot', async () => {
    const lot = {
      id: 'l1',
      tenantId: 't1',
      qty: 10,
      qtyRemaining: 3,
      status: 'ACTIVE',
      expiryDate: '2026-09-01',
      productId: 'p1',
      warehouseKode: 'GKERING',
    };
    const updates: Array<Record<string, unknown>> = [];
    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => [lot],
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

    const result = await syncLotsOnVariance(db as never, {
      tenantId: 't1',
      stokId: 'p1',
      warehouseKode: 'GKERING',
      deltaQty: 5,
      asOf: new Date('2026-07-25T12:00:00.000Z'),
      noDokumen: 'PS-2',
    });

    expect(result.increased).toBe(5);
    expect(updates[0]).toMatchObject({ qtyRemaining: 8, status: 'ACTIVE' });
  });

  it('skips when no lots on count up', async () => {
    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => [],
    };
    const db = {
      collection: () => ({ find: () => findCursor }),
    };
    const result = await syncLotsOnVariance(db as never, {
      tenantId: 't1',
      stokId: 'p1',
      warehouseKode: 'GKERING',
      deltaQty: 2,
    });
    expect(result.skippedNoLots).toBe(true);
  });
});
