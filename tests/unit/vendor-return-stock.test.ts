import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/uom/resolve-line-qty', () => ({
  resolveLineQtyBase: async () => ({
    qty: 2,
    qtyBase: 50,
    uomId: 'u-local',
    satuan: 'SAK',
    factorToBase: 25,
  }),
}));

const postStockMovements = vi.fn();
vi.mock('@/lib/stock-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stock-ledger')>()),
  postStockMovements: (...args: unknown[]) => postStockMovements(...args),
}));

vi.mock('@/lib/api/product-merge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/product-merge')>()),
  resolveStockProducts: async (_db: unknown, _tid: string, ids: string[]) => ({
    targets: new Map(ids.map((id) => [id, { sourceId: id, productId: id, merged: false, product: { id } }])),
  }),
  loadStockUomMapper: async () => (_sourceId: string, uomId: string | undefined) => uomId,
}));

import { applyVendorReturnStock, vendorReturnUnitCostBase } from '@/lib/api/vendor-return-stock';

const LINE = {
  lineId: 'inv:l1',
  invoiceLineId: 'l1',
  localStokId: 'p1',
  localKode: 'B1',
  localNama: 'Beras',
  satuan: 'SAK',
  uomId: 'u-local',
  qty: 2,
  qtyBase: 50,
  harga: 1000,
  jumlah: 2000,
  gudangKode: 'GKERING',
};

describe('applyVendorReturnStock', () => {
  beforeEach(() => {
    postStockMovements.mockReset();
  });

  it('gagal jika stok lokasi tidak cukup — tidak menandai sukses', async () => {
    postStockMovements.mockResolvedValue({
      ok: false,
      error: 'Stok di lokasi GKERING tidak cukup (sisa: 0)',
    });
    const result = await applyVendorReturnStock({} as never, 'sppg', 'RTV1', [LINE], undefined, { returnId: 'rtv-1' });
    expect(result.error).toMatch(/tidak cukup/);
    expect(result.items).toBeUndefined();
    expect(postStockMovements).toHaveBeenCalledTimes(1);
    const [, , input] = postStockMovements.mock.calls[0];
    expect(input).toMatchObject({ sourceType: 'VENDOR_RETURN', noTransaksi: 'RTV1' });
    expect(input.lines[0]).toMatchObject({ deltaQtyBase: -50, lotPolicy: { mode: 'FEFO_CONSUME' } });
  });

  it('sukses: satu posting buku stok + FEFO lot (lot pilihan), harga per satuan dasar, sourceId & pelaku', async () => {
    postStockMovements.mockResolvedValue({
      ok: true,
      productStok: { p1: 0 },
      lines: [{
        lineRef: '1:inv:l1',
        productId: 'p1',
        lokasiKode: 'GKERING',
        deltaQtyBase: -50,
        qtyLokasiAfter: 0,
        unitCost: 40,
        costSource: 'LINE',
        kartuId: 'k1',
        lot: {
          mode: 'FEFO_CONSUME',
          allocated: 50,
          shortfall: 0,
          skippedNoLots: false,
          allocations: [{ batchId: 'lot1', batchNo: 'L-1', expiryDate: '2026-12-01', qty: 50 }],
          kartuFields: {},
        },
      }],
    });
    const result = await applyVendorReturnStock(
      {} as never,
      'sppg',
      'RTV1',
      [{ ...LINE, lotNo: 'L-1' }],
      undefined,
      { returnId: 'rtv-1', actor: { userId: 'u1', userName: 'Admin' } },
    );
    expect(result.error).toBeUndefined();
    expect(result.items?.[0].qtyBase).toBe(50);
    const [, , input] = postStockMovements.mock.calls[0];
    expect(input).toMatchObject({
      sourceType: 'VENDOR_RETURN',
      sourceId: 'rtv-1',
      actor: { userId: 'u1', userName: 'Admin' },
    });
    expect(input.lines[0]).toMatchObject({
      lineRef: '1:inv:l1',
      unitCost: 40,
      lotPolicy: { mode: 'FEFO_CONSUME', preferredLotNo: 'L-1' },
    });
    expect(result.lotConsume?.[0]).toMatchObject({ lineId: 'inv:l1', allocated: 50, needQty: 50 });
    expect(result.lotConsume?.[0].allocations).toHaveLength(1);
  });

  it('harga per satuan dasar = harga × qty / qtyBase', () => {
    expect(vendorReturnUnitCostBase(1000, 2, 50)).toBe(40);
    expect(vendorReturnUnitCostBase(0, 2, 50)).toBeUndefined();
    expect(vendorReturnUnitCostBase(1000, 0, 50)).toBeUndefined();
  });
});
