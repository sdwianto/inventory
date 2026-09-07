import { describe, expect, it, vi } from 'vitest';

const peekMock = vi.fn(async () => 'LOT-FEFO-1');
vi.mock('@/lib/food-production/ingredient-lot-consume', () => ({
  peekFefoLotNo: (...args: unknown[]) => peekMock(...args),
}));

vi.mock('@/lib/api/product-uom', () => ({
  listProductUomsByProductIds: async () => new Map([
    ['p1', [{ id: 'u1', satuan: 'KG', vendorUomId: 'vu1', factorToBase: 1 }]],
  ]),
}));

vi.mock('@/lib/uom/resolve-line-qty', () => ({
  resolveLineQtyBaseFromUoms: () => ({
    qty: 5,
    qtyBase: 5,
    uomId: 'u1',
    satuan: 'KG',
    factorToBase: 1,
  }),
}));

import { buildVendorReturnLinesFromHutang } from '@/lib/api/vendor-return-map';

describe('buildVendorReturnLinesFromHutang — lotNo FEFO hydrate', () => {
  it('mengisi lotNo dari peekFefoLotNo', async () => {
    peekMock.mockClear();
    peekMock.mockResolvedValue('LOT-FEFO-1');

    const db = {
      collection: (name: string) => {
        if (name === 'products') {
          return {
            findOne: async () => ({
              id: 'p1',
              kode: 'B1',
              nama: 'Beras',
              gudangKode: 'GKERING',
              aktif: true,
            }),
          };
        }
        throw new Error(name);
      },
    } as never;

    const hutang = {
      items: [{
        lineId: 'l1',
        stokId: 'vs1',
        kode: 'B1',
        nama: 'Beras',
        satuan: 'KG',
        uomId: 'vu1',
        qty: 5,
        harga: 1000,
      }],
    };

    const { items } = await buildVendorReturnLinesFromHutang(db, 'sppg', hutang, []);
    expect(items).toHaveLength(1);
    expect(items[0].lotNo).toBe('LOT-FEFO-1');
    expect(peekMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        tenantId: 'sppg',
        stokId: 'p1',
        warehouseKode: 'GKERING',
      }),
    );
  });

  it('tanpa lotNo jika peek mengembalikan null', async () => {
    peekMock.mockClear();
    peekMock.mockResolvedValue(null);

    const db = {
      collection: (name: string) => {
        if (name === 'products') {
          return {
            findOne: async () => ({
              id: 'p1',
              kode: 'B1',
              nama: 'Beras',
              gudangKode: 'GKERING',
              aktif: true,
            }),
          };
        }
        throw new Error(name);
      },
    } as never;

    const hutang = {
      items: [{
        lineId: 'l1',
        stokId: 'vs1',
        kode: 'B1',
        nama: 'Beras',
        satuan: 'KG',
        uomId: 'vu1',
        qty: 5,
        harga: 1000,
      }],
    };

    const { items } = await buildVendorReturnLinesFromHutang(db, 'sppg', hutang, []);
    expect(items[0].lotNo).toBeUndefined();
  });
});
