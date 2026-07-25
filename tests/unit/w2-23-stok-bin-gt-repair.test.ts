import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'repair-gt-uuid-1'),
}));

const consumeStokBinSoft = vi.fn();

vi.mock('@/lib/api/stok-bin-consume', () => ({
  consumeStokBinSoft: (...args: unknown[]) => consumeStokBinSoft(...args),
}));

import { STOK_BIN_COLLECTION } from '@/lib/api/stok-bin';
import {
  repairStokBinGtMismatches,
  STOK_BIN_RECONCILE_REPORTS_COLLECTION,
} from '@/lib/api/stok-bin-reconcile';

function mockDb(binAgg: unknown[], lokasiRows: unknown[]) {
  const insertOne = vi.fn(async () => ({ insertedId: 'x' }));
  return {
    insertOne,
    db: {
      collection: (name: string) => {
        if (name === STOK_BIN_COLLECTION || name === 'stok_bin') {
          return {
            aggregate: () => ({
              toArray: async () => binAgg,
            }),
          };
        }
        if (name === 'stok_lokasi') {
          const cursor = {
            limit: () => cursor,
            toArray: async () => lokasiRows,
          };
          return { find: () => cursor };
        }
        if (name === STOK_BIN_RECONCILE_REPORTS_COLLECTION) {
          return { insertOne };
        }
        return { insertOne };
      },
    },
  };
}

describe('W2-23 repairStokBinGtMismatches (BIN_SUM_GT)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('consumes overage for BIN_SUM_GT and counts repaired=1', async () => {
    consumeStokBinSoft.mockResolvedValue({
      allocated: 2,
      shortfall: 0,
      skippedNoBins: false,
      takes: [{ binKode: 'RCV', qty: 2 }],
    });

    const { db, insertOne } = mockDb(
      [{ _id: { stokId: 'p1', warehouseKode: 'GKERING' }, qtySum: 12 }],
      [{ stokId: 'p1', lokasiKode: 'GKERING', qty: 10 }],
    );

    const result = await repairStokBinGtMismatches(db as never, 't1');

    expect(consumeStokBinSoft).toHaveBeenCalledWith(
      expect.anything(),
      't1',
      'p1',
      'GKERING',
      2,
    );
    expect(result.repaired).toBe(1);
    expect(result.ignoredLt).toBe(0);
    expect(result.actions).toEqual([
      expect.objectContaining({
        kind: 'BIN_SUM_GT_STOK_LOKASI',
        stokId: 'p1',
        warehouseKode: 'GKERING',
        residual: 2,
        allocated: 2,
      }),
    ]);
    expect(insertOne).toHaveBeenCalledTimes(2);
    expect(insertOne.mock.calls[0][0]).toMatchObject({ phase: 'detect-before-repair-gt' });
    expect(insertOne.mock.calls[1][0]).toMatchObject({
      phase: 'detect-after-repair-gt',
      repairActions: expect.any(Array),
    });
  });

  it('ignores BIN_SUM_LT and does not consume', async () => {
    consumeStokBinSoft.mockResolvedValue({
      allocated: 1,
      shortfall: 0,
      skippedNoBins: false,
      takes: [{ binKode: 'RCV', qty: 1 }],
    });

    const { db } = mockDb(
      [{ _id: { stokId: 'p1', warehouseKode: 'GKERING' }, qtySum: 7 }],
      [{ stokId: 'p1', lokasiKode: 'GKERING', qty: 10 }],
    );

    const result = await repairStokBinGtMismatches(db as never, 't1');

    expect(consumeStokBinSoft).not.toHaveBeenCalled();
    expect(result.repaired).toBe(0);
    expect(result.ignoredLt).toBeGreaterThanOrEqual(1);
    expect(result.actions).toEqual([]);
  });

  it('records SKIP_NO_BINS when consume soft-skips', async () => {
    consumeStokBinSoft.mockResolvedValue({
      allocated: 0,
      shortfall: 3,
      skippedNoBins: true,
      takes: [],
    });

    const { db } = mockDb(
      [{ _id: { stokId: 'p1', warehouseKode: 'GKERING' }, qtySum: 13 }],
      [{ stokId: 'p1', lokasiKode: 'GKERING', qty: 10 }],
    );

    const result = await repairStokBinGtMismatches(db as never, 't1');

    expect(consumeStokBinSoft).toHaveBeenCalledWith(
      expect.anything(),
      't1',
      'p1',
      'GKERING',
      3,
    );
    expect(result.repaired).toBe(0);
    expect(result.skippedNoBins).toBe(1);
    expect(result.actions.some((a) => a.kind === 'SKIP_NO_BINS')).toBe(true);
  });
});
