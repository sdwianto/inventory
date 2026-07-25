import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildIngredientLotNo,
  defaultIngredientExpiryDate,
  effectiveIngredientQtyRemaining,
  DEFAULT_INGREDIENT_SHELF_DAYS,
} from '@/lib/food-production/ingredient-lot';
import {
  detectIngredientLotMismatches,
  repairIngredientLotMismatches,
} from '@/lib/api/ingredient-lot-reconcile';

vi.mock('@/lib/api/stok-lokasi', () => ({
  getQtyStokLokasi: vi.fn(async () => 5),
}));

describe('W2-5 ingredient lot helpers', () => {
  it('builds stable lot numbers', () => {
    expect(buildIngredientLotNo({
      noGRN: 'GRN-2401',
      productKode: 'BRS-01',
      lineIndex: 0,
      receivedAt: '2026-07-25',
    })).toBe('L-2401-BRS01-20260725-1');
  });

  it('defaults expiry by shelf days', () => {
    expect(defaultIngredientExpiryDate('2026-07-25', 30)).toBe('2026-08-24');
    expect(DEFAULT_INGREDIENT_SHELF_DAYS).toBe(30);
  });

  it('effective remaining defaults', () => {
    expect(effectiveIngredientQtyRemaining({ qty: 8, status: 'ACTIVE' })).toBe(8);
    expect(effectiveIngredientQtyRemaining({ qty: 8, status: 'CONSUMED' })).toBe(0);
    expect(effectiveIngredientQtyRemaining({ qty: 8, qtyRemaining: 3, status: 'ACTIVE' })).toBe(3);
  });
});

describe('W2-5 ingredient lot Detect/Repair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags ACTIVE past expiry and lot vs stok', async () => {
    const lots = [
      {
        id: 'l1',
        lotNo: 'L-1',
        tenantId: 't1',
        expiryDate: '2026-07-01',
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
    const db = {
      collection: () => ({ find: () => findCursor }),
    };

    const report = await detectIngredientLotMismatches(db as never, 't1', {
      asOf: new Date('2026-07-25T12:00:00.000Z'),
    });
    expect(report.summary.activePastExpiry).toBe(1);
    expect(report.summary.lotVsStok).toBe(1); // 10 > 5
    expect(report.mismatches.some((m) => m.kind === 'ACTIVE_PAST_EXPIRY')).toBe(true);
  });

  it('repair marks ACTIVE_PAST_EXPIRY → EXPIRED', async () => {
    const lots = [
      {
        id: 'l1',
        lotNo: 'L-1',
        tenantId: 't1',
        expiryDate: '2026-07-01',
        status: 'ACTIVE',
        qty: 4,
        qtyRemaining: 4,
        productId: 'p1',
        warehouseKode: 'GKERING',
      },
    ];
    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => lots,
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
    expect(result.repaired).toBeGreaterThanOrEqual(1);
    expect(updateOne).toHaveBeenCalled();
    expect(result.actions[0]?.kind).toBe('ACTIVE_PAST_EXPIRY');
  });
});
