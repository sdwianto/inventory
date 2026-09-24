import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/stock-ledger/bin', () => ({
  STOK_BIN_COLLECTION: 'stok_bin',
  adjustStokBin: vi.fn(),
}));

vi.mock('@/lib/api/warehouse-bins', () => ({
  resolveDefaultBinKode: vi.fn(),
}));

import { adjustStokBin } from '@/lib/stock-ledger/bin';
import { resolveDefaultBinKode } from '@/lib/api/warehouse-bins';
import {
  allocateStokBinSoft,
  softPutawayBinOnWarehouseIn,
} from '@/lib/stock-ledger/bin-allocate';

const adjustMock = vi.mocked(adjustStokBin);
const resolveDefaultMock = vi.mocked(resolveDefaultBinKode);

const db = {} as never;

describe('W2-21 allocateStokBinSoft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adjustMock.mockResolvedValue({ qty: 10 });
    resolveDefaultMock.mockResolvedValue(null);
  });

  it('allocates +qty to default bin', async () => {
    resolveDefaultMock.mockResolvedValue('RCV');

    const res = await allocateStokBinSoft(db, 't1', 'p1', 'GKERING', 5);

    expect(res).toEqual({
      allocated: 5,
      binKode: 'RCV',
      skippedNoDefaultBin: false,
    });
    expect(resolveDefaultMock).toHaveBeenCalledWith(db, 't1', 'GKERING');
    expect(adjustMock).toHaveBeenCalledWith(db, 't1', 'p1', 'GKERING', 'RCV', 5, undefined);
  });

  it('skips when no default bin', async () => {
    resolveDefaultMock.mockResolvedValue(null);

    const res = await allocateStokBinSoft(db, 't1', 'p1', 'GKERING', 4);

    expect(res).toEqual({
      allocated: 0,
      skippedNoDefaultBin: true,
    });
    expect(adjustMock).not.toHaveBeenCalled();
  });

  it('returns zeros when qtyNeed <= 0', async () => {
    const res = await allocateStokBinSoft(db, 't1', 'p1', 'GKERING', 0);
    expect(res).toEqual({ allocated: 0, skippedNoDefaultBin: false });
    expect(resolveDefaultMock).not.toHaveBeenCalled();
    expect(adjustMock).not.toHaveBeenCalled();
  });
});

describe('W2-21 softPutawayBinOnWarehouseIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to allocateStokBinSoft', async () => {
    resolveDefaultMock.mockResolvedValue('RCV');
    adjustMock.mockResolvedValue({ qty: 8 });
    const allocateFn = vi.fn(allocateStokBinSoft);

    const res = await softPutawayBinOnWarehouseIn(
      db,
      't1',
      'p1',
      'GBASAH',
      3,
      undefined,
      allocateFn,
    );

    expect(allocateFn).toHaveBeenCalledWith(db, 't1', 'p1', 'GBASAH', 3, undefined);
    expect(res.allocated).toBe(3);
    expect(res.binKode).toBe('RCV');
  });

  it('swallows throw from allocate and returns soft skip', async () => {
    const allocateFn = vi.fn(async () => {
      throw new Error('bin boom');
    });

    const res = await softPutawayBinOnWarehouseIn(
      db,
      't1',
      'p1',
      'GKERING',
      7,
      undefined,
      allocateFn,
    );

    expect(allocateFn).toHaveBeenCalled();
    expect(res).toEqual({
      allocated: 0,
      skippedNoDefaultBin: true,
    });
  });
});

describe('W2-21 transfer/stock-mutation call sites', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '../../', rel), 'utf8');

  it('transfer POST path posts IN on lokasiTujuan after OUT asal, via the ledger', () => {
    const src = read('lib/api/handlers/inventory-transfer.ts');
    expect(src).not.toContain('softPutawayBinOnWarehouseIn');
    const outIdx = src.search(/warehouseKode: String\(invBody\.lokasiAsal\),\s*deltaQtyBase: -it\.qtyBase/);
    const inIdx = src.search(/warehouseKode: String\(invBody\.lokasiTujuan\),\s*deltaQtyBase: it\.qtyBase/);
    expect(outIdx).toBeGreaterThan(-1);
    expect(inIdx).toBeGreaterThan(outIdx);
  });

  it('stock ledger IN path uses softPutawayBinOnWarehouseIn', () => {
    const src = read('lib/stock-ledger/post-stock-movements.ts');
    expect(src).toContain('softPutawayBinOnWarehouseIn');
    expect(src).toMatch(/if \(l\.delta < 0\)/);
  });
});
