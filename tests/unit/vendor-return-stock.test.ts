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

const postStockMutation = vi.fn();
const consumeIngredientLotsFefo = vi.fn();
vi.mock('@/lib/api/stock-mutation', () => ({
  postStockMutation: (...args: unknown[]) => postStockMutation(...args),
}));
vi.mock('@/lib/food-production/ingredient-lot-consume', () => ({
  consumeIngredientLotsFefo: (...args: unknown[]) => consumeIngredientLotsFefo(...args),
}));

import { applyVendorReturnStock } from '@/lib/api/vendor-return-stock';

describe('applyVendorReturnStock', () => {
  beforeEach(() => {
    postStockMutation.mockReset();
    consumeIngredientLotsFefo.mockReset();
    consumeIngredientLotsFefo.mockResolvedValue({
      stokId: 'p1',
      warehouseKode: 'GKERING',
      needQty: 50,
      allocated: 0,
      shortfall: 50,
      allocations: [],
      skippedNoLots: true,
    });
  });

  it('gagal jika stok lokasi tidak cukup — tidak menandai sukses', async () => {
    postStockMutation.mockResolvedValue({
      ok: false,
      error: 'Stok di lokasi GKERING tidak cukup (sisa: 0)',
    });
    const result = await applyVendorReturnStock(
      {} as never,
      'sppg',
      'RTV1',
      [{
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
      }],
    );
    expect(result.error).toMatch(/tidak cukup/);
    expect(result.items).toBeUndefined();
    expect(postStockMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceType: 'VENDOR_RETURN',
        deltaQtyBase: -50,
        noTransaksi: 'RTV1',
      }),
    );
    expect(consumeIngredientLotsFefo).not.toHaveBeenCalled();
  });

  it('sukses menulis mutasi OUT VENDOR_RETURN + FEFO soft consume', async () => {
    postStockMutation.mockResolvedValue({ ok: true, qtyAfter: 0, lokasiKode: 'GKERING' });
    consumeIngredientLotsFefo.mockResolvedValue({
      stokId: 'p1',
      warehouseKode: 'GKERING',
      needQty: 50,
      allocated: 50,
      shortfall: 0,
      skippedNoLots: false,
      allocations: [{ batchId: 'lot1', batchNo: 'L-1', expiryDate: '2026-12-01', qty: 50 }],
    });
    const result = await applyVendorReturnStock(
      {} as never,
      'sppg',
      'RTV1',
      [{
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
        lotNo: 'L-1',
      }],
    );
    expect(result.error).toBeUndefined();
    expect(result.items?.[0].qtyBase).toBe(50);
    expect(postStockMutation.mock.calls[0][1].sourceType).toBe('VENDOR_RETURN');
    expect(consumeIngredientLotsFefo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stokId: 'p1',
        needQty: 50,
        preferredLotNo: 'L-1',
        noDokumen: 'RTV1',
      }),
      undefined,
    );
    expect(result.lotConsume?.[0].allocations).toHaveLength(1);
  });
});
