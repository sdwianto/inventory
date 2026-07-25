import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('uuid', () => ({ v4: () => 'stok-bin-uuid-1' }));

import { normalizeBinKode, isValidBinKode } from '@/lib/api/warehouse-bins';
import { adjustStokBin, STOK_BIN_COLLECTION } from '@/lib/api/stok-bin';
import {
  detectStokBinVsLokasi,
  runStokBinDetect,
  STOK_BIN_RECONCILE_REPORTS_COLLECTION,
} from '@/lib/api/stok-bin-reconcile';

describe('W2-17 bin kode normalize', () => {
  it('normalizes and validates bin kode', () => {
    expect(normalizeBinKode('  rcv-01 ')).toBe('RCV-01');
    expect(isValidBinKode('RCV')).toBe(true);
    expect(isValidBinKode('')).toBe(false);
  });
});

describe('W2-17 adjustStokBin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('increments via findOneAndUpdate upsert', async () => {
    const findOneAndUpdate = vi.fn(async () => ({ qty: 15 }));
    const db = {
      collection: (name: string) => {
        expect(name).toBe(STOK_BIN_COLLECTION);
        return { findOneAndUpdate };
      },
    };
    const res = await adjustStokBin(db as never, 't1', 'p1', 'GKERING', 'RCV', 5);
    expect(res).toEqual({ qty: 15 });
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      tenantId: 't1',
      stokId: 'p1',
      warehouseKode: 'GKERING',
      binKode: 'RCV',
    });
    expect(update.$inc).toEqual({ qty: 5 });
    expect(opts.upsert).toBe(true);
  });

  it('guards negative delta when qty insufficient', async () => {
    const findOneAndUpdate = vi.fn(async () => null);
    const findOne = vi.fn(async () => ({ qty: 2 }));
    const db = {
      collection: () => ({ findOneAndUpdate, findOne }),
    };
    const res = await adjustStokBin(db as never, 't1', 'p1', 'GKERING', 'RCV', -5);
    expect(res).toEqual({ error: 'Stok di bin RCV@GKERING tidak cukup (sisa: 2)' });
  });
});

describe('W2-17 detectStokBinVsLokasi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockDb(binAgg: unknown[], lokasiRows: unknown[]) {
    return {
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
          return {
            find: () => cursor,
          };
        }
        return {
          insertOne: vi.fn(async () => ({ insertedId: 'x' })),
        };
      },
    };
  }

  it('flags BIN_SUM_GT when bin sum > stok_lokasi', async () => {
    const db = mockDb(
      [{ _id: { stokId: 'p1', warehouseKode: 'GKERING' }, qtySum: 20 }],
      [{ stokId: 'p1', lokasiKode: 'GKERING', qty: 10 }],
    );
    const report = await detectStokBinVsLokasi(db as never, 't1');
    expect(report.summary.binSumGt).toBe(1);
    expect(report.summary.binSumLt).toBe(0);
    expect(report.mismatches[0]?.kind).toBe('BIN_SUM_GT_STOK_LOKASI');
  });

  it('flags BIN_SUM_LT when bin sum < stok_lokasi', async () => {
    const db = mockDb(
      [{ _id: { stokId: 'p1', warehouseKode: 'GKERING' }, qtySum: 3 }],
      [{ stokId: 'p1', lokasiKode: 'GKERING', qty: 12 }],
    );
    const report = await detectStokBinVsLokasi(db as never, 't1');
    expect(report.summary.binSumLt).toBe(1);
    expect(report.summary.binSumGt).toBe(0);
    expect(report.mismatches[0]?.kind).toBe('BIN_SUM_LT_STOK_LOKASI');
  });

  it('persists report on runStokBinDetect', async () => {
    const insertOne = vi.fn(async () => ({ insertedId: 'r1' }));
    const db = {
      collection: (name: string) => {
        if (name === STOK_BIN_COLLECTION || name === 'stok_bin') {
          return {
            aggregate: () => ({
              toArray: async () => [
                { _id: { stokId: 'p1', warehouseKode: 'GKERING' }, qtySum: 1 },
              ],
            }),
          };
        }
        if (name === 'stok_lokasi') {
          const cursor = {
            limit: () => cursor,
            toArray: async () => [{ stokId: 'p1', lokasiKode: 'GKERING', qty: 1 }],
          };
          return { find: () => cursor };
        }
        if (name === STOK_BIN_RECONCILE_REPORTS_COLLECTION) {
          return { insertOne };
        }
        return { insertOne };
      },
    };
    const report = await runStokBinDetect(db as never, 't1');
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(report.id).toBe('stok-bin-uuid-1');
  });
});
