import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/stok-bin', () => ({
  adjustStokBin: vi.fn(),
}));

import { adjustStokBin } from '@/lib/api/stok-bin';
import {
  normalizePutawayLine,
  postPutawayMoveBins,
} from '@/lib/api/putaway-move';

const adjustMock = vi.mocked(adjustStokBin);

describe('W2-18 normalizePutawayLine', () => {
  it('rejects from === to', () => {
    const res = normalizePutawayLine({
      stokId: 'p1',
      fromBinKode: 'RCV',
      toBinKode: 'rcv',
      qty: 5,
      qtyBase: 5,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/tidak boleh sama/i);
  });

  it('rejects qtyBase <= 0', () => {
    const res = normalizePutawayLine({
      stokId: 'p1',
      fromBinKode: 'RCV',
      toBinKode: 'A-01',
      qty: 0,
      qtyBase: 0,
    });
    expect(res.ok).toBe(false);
  });

  it('normalizes bins and accepts valid line', () => {
    const res = normalizePutawayLine({
      stokId: 'p1',
      fromBinKode: ' rcv ',
      toBinKode: 'a-01',
      qty: 3,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.line.fromBinKode).toBe('RCV');
      expect(res.line.toBinKode).toBe('A-01');
      expect(res.line.qtyBase).toBe(3);
    }
  });
});

describe('W2-18 postPutawayMoveBins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls adjustStokBin -from then +to per line', async () => {
    adjustMock.mockResolvedValue({ qty: 1 });
    const db = {} as never;
    await postPutawayMoveBins(db, 't1', {
      warehouseKode: 'GKERING',
      noPutaway: 'PA2607000001',
      lines: [
        {
          stokId: 'p1',
          fromBinKode: 'RCV',
          toBinKode: 'A-01',
          qty: 5,
          qtyBase: 5,
        },
      ],
    });
    expect(adjustMock).toHaveBeenCalledTimes(2);
    expect(adjustMock.mock.calls[0].slice(1, 6)).toEqual(['t1', 'p1', 'GKERING', 'RCV', -5]);
    expect(adjustMock.mock.calls[1].slice(1, 6)).toEqual(['t1', 'p1', 'GKERING', 'A-01', 5]);
  });

  it('propagates OUT guard error from adjustStokBin', async () => {
    adjustMock.mockResolvedValueOnce({ error: 'Stok di bin RCV@GKERING tidak cukup (sisa: 0)' });
    await expect(
      postPutawayMoveBins({} as never, 't1', {
        warehouseKode: 'GKERING',
        noPutaway: 'PA2607000002',
        lines: [
          {
            stokId: 'p1',
            fromBinKode: 'RCV',
            toBinKode: 'A-01',
            qty: 2,
            qtyBase: 2,
          },
        ],
      }),
    ).rejects.toThrow(/tidak cukup/i);
    expect(adjustMock).toHaveBeenCalledTimes(1);
  });

  it('rejects from===to before adjust', async () => {
    await expect(
      postPutawayMoveBins({} as never, 't1', {
        warehouseKode: 'GKERING',
        noPutaway: 'PA2607000003',
        lines: [
          {
            stokId: 'p1',
            fromBinKode: 'RCV',
            toBinKode: 'RCV',
            qty: 1,
            qtyBase: 1,
          },
        ],
      }),
    ).rejects.toThrow(/tidak boleh sama/i);
    expect(adjustMock).not.toHaveBeenCalled();
  });
});
