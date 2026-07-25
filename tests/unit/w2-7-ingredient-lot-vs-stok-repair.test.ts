import { describe, it, expect, vi, beforeEach } from 'vitest';
import { repairIngredientLotMismatches } from '@/lib/api/ingredient-lot-reconcile';

const consumeIngredientLotsFefo = vi.fn();

vi.mock('@/lib/food-production/ingredient-lot-consume', () => ({
  consumeIngredientLotsFefo: (...args: unknown[]) => consumeIngredientLotsFefo(...args),
}));

vi.mock('@/lib/api/stok-lokasi', () => ({
  getQtyStokLokasi: vi.fn(async () => 5),
}));

describe('W2-7 repair LOT_VS_STOK_LOKASI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('consumes excess lots when sum(qtyRemaining) > stok_lokasi', async () => {
    consumeIngredientLotsFefo.mockResolvedValue({
      allocated: 5,
      shortfall: 0,
      skippedNoLots: false,
      needQty: 5,
      stokId: 'p1',
      warehouseKode: 'GKERING',
      allocations: [],
    });

    const lots = [
      {
        id: 'l1',
        lotNo: 'L-1',
        tenantId: 't1',
        expiryDate: '2026-08-10',
        status: 'ACTIVE',
        qty: 10,
        qtyRemaining: 10,
        productId: 'p1',
        warehouseKode: 'GKERING',
      },
    ];
    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => lots,
    };
    const updateOne = vi.fn(async () => ({ modifiedCount: 0 }));
    const insertOne = vi.fn(async () => ({ insertedId: 'x' }));
    const db = {
      collection: (name: string) => {
        if (name === 'ingredient_lots') {
          return { find: () => findCursor, updateOne };
        }
        return { find: () => findCursor, insertOne };
      },
    };

    const result = await repairIngredientLotMismatches(db as never, 't1');
    expect(consumeIngredientLotsFefo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stokId: 'p1',
        warehouseKode: 'GKERING',
        needQty: 5, // 10 - 5
        allowExpired: true,
      }),
    );
    expect(result.repaired).toBeGreaterThanOrEqual(1);
    expect(result.actions.some((a) => a.kind === 'LOT_VS_STOK_LOKASI')).toBe(true);
  });

  it('still marks ACTIVE_PAST_EXPIRY', async () => {
    consumeIngredientLotsFefo.mockResolvedValue({
      allocated: 0,
      shortfall: 0,
      skippedNoLots: true,
      needQty: 0,
      stokId: 'p1',
      warehouseKode: 'GKERING',
      allocations: [],
    });

    const lots = [
      {
        id: 'l-exp',
        lotNo: 'L-EXP',
        tenantId: 't1',
        expiryDate: '2026-07-01',
        status: 'ACTIVE',
        qty: 2,
        qtyRemaining: 2,
        productId: 'p1',
        warehouseKode: 'GKERING',
      },
    ];
    // After marking expired, second detect still may see LOT_VS_STOK — keep simple
    let call = 0;
    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => {
        call += 1;
        if (call <= 2) return lots;
        return [{ ...lots[0], status: 'EXPIRED' }];
      },
    };
    const updateOne = vi.fn(async () => ({ modifiedCount: 1 }));
    const insertOne = vi.fn(async () => ({ insertedId: 'x' }));
    const db = {
      collection: (name: string) => {
        if (name === 'ingredient_lots') {
          return { find: () => findCursor, updateOne };
        }
        return { find: () => findCursor, insertOne };
      },
    };

    const result = await repairIngredientLotMismatches(db as never, 't1');
    expect(result.actions.some((a) => a.kind === 'ACTIVE_PAST_EXPIRY')).toBe(true);
    expect(updateOne).toHaveBeenCalled();
  });
});
