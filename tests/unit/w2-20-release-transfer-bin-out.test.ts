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

vi.mock('@/lib/api/transaction', () => ({
  txOpts: (session?: unknown) => (session ? { session } : {}),
}));

import { adjustStokBin } from '@/lib/stock-ledger/bin';
import { resolveDefaultBinKode } from '@/lib/api/warehouse-bins';
import {
  consumeStokBinSoft,
  softConsumeBinOnWarehouseOut,
} from '@/lib/stock-ledger/bin-consume';

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

describe('W2-20 softConsumeBinOnWarehouseOut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adjustMock.mockResolvedValue({ qty: 0 });
    resolveDefaultMock.mockResolvedValue(null);
  });

  it('delegates to consumeStokBinSoft', async () => {
    resolveDefaultMock.mockResolvedValue('RCV');
    const db = mockDb([{ binKode: 'RCV', qty: 5 }]);
    const consumeFn = vi.fn(consumeStokBinSoft);

    const res = await softConsumeBinOnWarehouseOut(
      db as never,
      't1',
      'p1',
      'GKERING',
      3,
      undefined,
      consumeFn,
    );

    expect(consumeFn).toHaveBeenCalledWith(db, 't1', 'p1', 'GKERING', 3, undefined);
    expect(res.allocated).toBe(3);
    expect(res.shortfall).toBe(0);
    expect(res.takes).toEqual([{ binKode: 'RCV', qty: 3 }]);
    expect(adjustMock).toHaveBeenCalledWith(db, 't1', 'p1', 'GKERING', 'RCV', -3, undefined);
  });

  it('swallows throw from consume and returns soft shortfall', async () => {
    const consumeFn = vi.fn(async () => {
      throw new Error('bin boom');
    });

    const res = await softConsumeBinOnWarehouseOut(
      mockDb([]) as never,
      't1',
      'p1',
      'GKERING',
      7,
      undefined,
      consumeFn,
    );

    expect(consumeFn).toHaveBeenCalled();
    expect(res).toEqual({
      allocated: 0,
      shortfall: 7,
      skippedNoBins: true,
      takes: [],
    });
  });

  it('normalizes negative qty to absolute need', async () => {
    const consumeFn = vi.fn(async () => ({
      allocated: 2,
      shortfall: 0,
      skippedNoBins: false,
      takes: [{ binKode: 'RCV', qty: 2 }],
    }));

    await softConsumeBinOnWarehouseOut(
      mockDb([]) as never,
      't1',
      'p1',
      'GBASAH',
      -2,
      undefined,
      consumeFn,
    );

    expect(consumeFn).toHaveBeenCalledWith(
      expect.anything(),
      't1',
      'p1',
      'GBASAH',
      2,
      undefined,
    );
  });
});

describe('W2-20 release/transfer call sites', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '../../', rel), 'utf8');

  it('release approve path posts OUT through the stock ledger (bin consume centralized)', () => {
    const src = read('lib/api/handlers/inventory-releases.ts');
    expect(src).toContain('postStockMovements');
    expect(src).toContain('deltaQtyBase: -it.qtyBase');
    expect(src).not.toContain('softConsumeBinOnWarehouseOut');
  });

  it('transfer POST path posts OUT on lokasiAsal through the ledger, no direct bin calls', () => {
    const src = read('lib/api/handlers/inventory-transfer.ts');
    expect(src).toContain('postStockMovements');
    expect(src).toMatch(/warehouseKode: String\(invBody\.lokasiAsal\),\s*deltaQtyBase: -it\.qtyBase/);
    expect(src).not.toContain('softConsumeBinOnWarehouseOut');
  });

  it('stock ledger OUT path uses softConsumeBinOnWarehouseOut', () => {
    const src = read('lib/stock-ledger/post-stock-movements.ts');
    expect(src).toContain('softConsumeBinOnWarehouseOut');
    expect(src).not.toContain('consumeStokBinSoft');
  });
});
