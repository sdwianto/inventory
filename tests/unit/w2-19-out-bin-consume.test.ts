import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/stok-bin', () => ({
  STOK_BIN_COLLECTION: 'stok_bin',
  adjustStokBin: vi.fn(),
}));

vi.mock('@/lib/api/warehouse-bins', () => ({
  resolveDefaultBinKode: vi.fn(),
}));

vi.mock('@/lib/api/transaction', () => ({
  txOpts: (session?: unknown) => (session ? { session } : {}),
}));

import { adjustStokBin } from '@/lib/api/stok-bin';
import { resolveDefaultBinKode } from '@/lib/api/warehouse-bins';
import { consumeStokBinSoft } from '@/lib/api/stok-bin-consume';

const adjustMock = vi.mocked(adjustStokBin);
const resolveDefaultMock = vi.mocked(resolveDefaultBinKode);

function mockDb(rows: Array<{ binKode: string; qty: number }>) {
  return {
    collection: () => ({
      find: () => ({
        toArray: async () => rows,
      }),
    }),
  };
}

describe('W2-19 consumeStokBinSoft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adjustMock.mockResolvedValue({ qty: 0 });
    resolveDefaultMock.mockResolvedValue(null);
  });

  it('returns zeros when qtyNeed <= 0', async () => {
    const res = await consumeStokBinSoft(mockDb([]) as never, 't1', 'p1', 'GKERING', 0);
    expect(res).toEqual({ allocated: 0, shortfall: 0, skippedNoBins: false, takes: [] });
    expect(adjustMock).not.toHaveBeenCalled();
  });

  it('skips invalid warehouse without failing', async () => {
    const res = await consumeStokBinSoft(mockDb([]) as never, 't1', 'p1', 'UNKNOWN', 5);
    expect(res.skippedNoBins).toBe(true);
    expect(res.allocated).toBe(0);
    expect(res.shortfall).toBe(5);
    expect(adjustMock).not.toHaveBeenCalled();
  });

  it('soft skip when no bins', async () => {
    const res = await consumeStokBinSoft(mockDb([]) as never, 't1', 'p1', 'GKERING', 4);
    expect(res).toEqual({
      allocated: 0,
      shortfall: 4,
      skippedNoBins: true,
      takes: [],
    });
    expect(adjustMock).not.toHaveBeenCalled();
  });

  it('consumes default bin first then greedy by binKode', async () => {
    resolveDefaultMock.mockResolvedValue('RCV');
    const db = mockDb([
      { binKode: 'Z-99', qty: 3 },
      { binKode: 'A-01', qty: 5 },
      { binKode: 'RCV', qty: 2 },
    ]);

    const res = await consumeStokBinSoft(db as never, 't1', 'p1', 'GKERING', 6);

    expect(res.allocated).toBe(6);
    expect(res.shortfall).toBe(0);
    expect(res.skippedNoBins).toBe(false);
    expect(res.takes).toEqual([
      { binKode: 'RCV', qty: 2 },
      { binKode: 'A-01', qty: 4 },
    ]);
    expect(adjustMock.mock.calls.map((c) => c.slice(1, 6))).toEqual([
      ['t1', 'p1', 'GKERING', 'RCV', -2],
      ['t1', 'p1', 'GKERING', 'A-01', -4],
    ]);
  });

  it('multi-bin greedy without default uses binKode asc', async () => {
    resolveDefaultMock.mockResolvedValue(null);
    const db = mockDb([
      { binKode: 'B-02', qty: 4 },
      { binKode: 'A-01', qty: 3 },
    ]);

    const res = await consumeStokBinSoft(db as never, 't1', 'p1', 'GBASAH', 5);

    expect(res.takes).toEqual([
      { binKode: 'A-01', qty: 3 },
      { binKode: 'B-02', qty: 2 },
    ]);
    expect(res.allocated).toBe(5);
    expect(res.shortfall).toBe(0);
  });

  it('reports shortfall when bins only cover partial qty', async () => {
    resolveDefaultMock.mockResolvedValue('RCV');
    const db = mockDb([
      { binKode: 'RCV', qty: 2 },
      { binKode: 'A-01', qty: 1 },
    ]);

    const res = await consumeStokBinSoft(db as never, 't1', 'p1', 'GKERING', 10);

    expect(res.allocated).toBe(3);
    expect(res.shortfall).toBe(7);
    expect(res.skippedNoBins).toBe(false);
    expect(res.takes).toEqual([
      { binKode: 'RCV', qty: 2 },
      { binKode: 'A-01', qty: 1 },
    ]);
  });

  it('skips a bin when adjustStokBin errors and continues soft', async () => {
    resolveDefaultMock.mockResolvedValue(null);
    adjustMock
      .mockResolvedValueOnce({ error: 'Stok di bin A-01@GKERING tidak cukup (sisa: 0)' })
      .mockResolvedValueOnce({ qty: 0 });

    const db = mockDb([
      { binKode: 'A-01', qty: 5 },
      { binKode: 'B-02', qty: 4 },
    ]);

    const res = await consumeStokBinSoft(db as never, 't1', 'p1', 'GKERING', 3);

    expect(res.takes).toEqual([{ binKode: 'B-02', qty: 3 }]);
    expect(res.allocated).toBe(3);
    expect(res.shortfall).toBe(0);
  });
});
