import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'repair-uuid-1'),
}));

const allocateStokBinSoft = vi.fn();

vi.mock('@/lib/api/stok-bin-allocate', () => ({
  allocateStokBinSoft: (...args: unknown[]) => allocateStokBinSoft(...args),
}));

import { STOK_BIN_COLLECTION } from '@/lib/api/stok-bin';
import {
  repairStokBinMismatches,
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

describe('W2-22 repairStokBinMismatches (BIN_SUM_LT)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allocates residual for BIN_SUM_LT and counts repaired=1', async () => {
    allocateStokBinSoft.mockResolvedValue({
      allocated: 3,
      binKode: 'RCV',
      skippedNoDefaultBin: false,
    });

    const { db, insertOne } = mockDb(
      [{ _id: { stokId: 'p1', warehouseKode: 'GKERING' }, qtySum: 7 }],
      [{ stokId: 'p1', lokasiKode: 'GKERING', qty: 10 }],
    );

    const result = await repairStokBinMismatches(db as never, 't1');

    expect(allocateStokBinSoft).toHaveBeenCalledWith(
      expect.anything(),
      't1',
      'p1',
      'GKERING',
      3,
    );
    expect(result.repaired).toBe(1);
    expect(result.ignoredGt).toBe(0);
    expect(result.actions).toEqual([
      expect.objectContaining({
        kind: 'BIN_SUM_LT_STOK_LOKASI',
        stokId: 'p1',
        warehouseKode: 'GKERING',
        binKode: 'RCV',
        residual: 3,
        allocated: 3,
      }),
    ]);
    expect(insertOne).toHaveBeenCalledTimes(2);
    expect(insertOne.mock.calls[0][0]).toMatchObject({ phase: 'detect-before-repair' });
    expect(insertOne.mock.calls[1][0]).toMatchObject({
      phase: 'detect-after-repair',
      repairActions: expect.any(Array),
    });
  });

  it('ignores BIN_SUM_GT and does not allocate', async () => {
    allocateStokBinSoft.mockResolvedValue({
      allocated: 1,
      binKode: 'RCV',
      skippedNoDefaultBin: false,
    });

    const { db } = mockDb(
      [{ _id: { stokId: 'p1', warehouseKode: 'GKERING' }, qtySum: 12 }],
      [{ stokId: 'p1', lokasiKode: 'GKERING', qty: 10 }],
    );

    const result = await repairStokBinMismatches(db as never, 't1');

    expect(allocateStokBinSoft).not.toHaveBeenCalled();
    expect(result.repaired).toBe(0);
    expect(result.ignoredGt).toBeGreaterThanOrEqual(1);
    expect(result.actions).toEqual([]);
  });

  it('records SKIP_NO_DEFAULT_BIN when allocate soft-skips', async () => {
    allocateStokBinSoft.mockResolvedValue({
      allocated: 0,
      skippedNoDefaultBin: true,
    });

    const { db } = mockDb(
      [{ _id: { stokId: 'p1', warehouseKode: 'GKERING' }, qtySum: 2 }],
      [{ stokId: 'p1', lokasiKode: 'GKERING', qty: 5 }],
    );

    const result = await repairStokBinMismatches(db as never, 't1');

    expect(allocateStokBinSoft).toHaveBeenCalledWith(
      expect.anything(),
      't1',
      'p1',
      'GKERING',
      3,
    );
    expect(result.repaired).toBe(0);
    expect(result.skippedNoDefaultBin).toBe(1);
    expect(result.actions.some((a) => a.kind === 'SKIP_NO_DEFAULT_BIN')).toBe(true);
  });
});
