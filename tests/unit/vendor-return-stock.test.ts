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
vi.mock('@/lib/api/stock-mutation', () => ({
  postStockMutation: (...args: unknown[]) => postStockMutation(...args),
}));

import { applyVendorReturnStock } from '@/lib/api/vendor-return-stock';

describe('applyVendorReturnStock', () => {
  beforeEach(() => {
    postStockMutation.mockReset();
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
  });

  it('sukses menulis mutasi OUT VENDOR_RETURN', async () => {
    postStockMutation.mockResolvedValue({ ok: true, qtyAfter: 0, lokasiKode: 'GKERING' });
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
    expect(result.error).toBeUndefined();
    expect(result.items?.[0].qtyBase).toBe(50);
    expect(postStockMutation.mock.calls[0][1].sourceType).toBe('VENDOR_RETURN');
  });
});
