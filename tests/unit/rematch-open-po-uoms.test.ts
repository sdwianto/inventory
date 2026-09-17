import { describe, it, expect, vi } from 'vitest';
import { rematchOpenCpoUomsForProduct } from '@/lib/api/rematch-open-po-uoms';
import type { ProductUom } from '@/lib/uom/types';

const uoms = [
  {
    id: 'new-kg',
    tenantId: 'sppg',
    productId: 'p1',
    satuan: 'KG',
    factorToBase: 10,
    vendorUomId: 'sales-kg',
    isBase: false,
    hargaEcer: 0,
    hargaGrosir: 0,
    hargaSpesial: 0,
    barcode: '',
    sortOrder: 1,
    aktif: true,
  },
] as ProductUom[];

describe('rematchOpenCpoUomsForProduct', () => {
  it('rebinds stale uomId/vendorUomId by satuan on open CPO', async () => {
    const updateOne = vi.fn(async () => ({ matchedCount: 1 }));
    const doc = {
      _id: 'oid1',
      noPO: 'CPO1',
      tenantId: 'sppg',
      status: 'PARTIAL_RECEIVED',
      items: [{
        localStokId: 'p1',
        kode: 'B1',
        qty: 1,
        satuan: 'KG',
        uomId: 'stale-local',
        vendorUomId: 'sales-ons-wrong',
      }],
    };
    const db = {
      collection: () => ({
        find: () => ({
          [Symbol.asyncIterator]: async function* () { yield doc; },
        }),
        updateOne,
      }),
    };

    const r = await rematchOpenCpoUomsForProduct(db as never, 'sppg', 'p1', uoms);
    expect(r.docsTouched).toBe(1);
    expect(r.linesPatched).toBe(1);
    expect(r.patches[0]).toMatchObject({
      noPO: 'CPO1',
      uomIdAfter: 'new-kg',
      vendorUomIdAfter: 'sales-kg',
    });
    expect(updateOne).toHaveBeenCalled();
    const setItems = updateOne.mock.calls[0][1].$set.items;
    expect(setItems[0].uomId).toBe('new-kg');
    expect(setItems[0].vendorUomId).toBe('sales-kg');
  });
});
