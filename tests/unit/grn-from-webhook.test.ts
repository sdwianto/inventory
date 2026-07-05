import { describe, expect, it } from 'vitest';
import { resolveLocalUomForGrnLine } from '@/lib/api/grn-from-webhook';
import type { ProductUom } from '@/lib/uom/types';

const uoms: ProductUom[] = [
  {
    id: 'local-base',
    tenantId: 'sppg',
    productId: 'p1',
    satuan: 'KG',
    isBase: true,
    factorToBase: 1,
    hargaEcer: 1000,
    hargaGrosir: 0,
    hargaSpesial: 0,
    barcode: '',
    sortOrder: 0,
    aktif: true,
    vendorUomId: 'vendor-base',
  },
  {
    id: 'local-box',
    tenantId: 'sppg',
    productId: 'p1',
    satuan: 'BOX',
    isBase: false,
    factorToBase: 12,
    hargaEcer: 11000,
    hargaGrosir: 0,
    hargaSpesial: 0,
    barcode: '',
    sortOrder: 1,
    aktif: true,
    vendorUomId: 'vendor-box',
  },
];

function mockDb(uomsByProduct: Map<string, ProductUom[]>) {
  return {
    collection: () => ({
      find: () => ({
        sort: () => ({
          toArray: async () => [],
        }),
      }),
    }),
  } as never;
}

describe('resolveLocalUomForGrnLine', () => {
  it('maps vendor uomId via vendorUomId', async () => {
    const cache = new Map<string, ProductUom[]>();
    cache.set('p1', uoms);
    const res = await resolveLocalUomForGrnLine(
      mockDb(new Map()),
      'sppg',
      'p1',
      { uomId: 'vendor-box', qty: 2, qtyBase: 24, satuan: 'BOX' },
      cache,
    );
    expect(res.uomId).toBe('local-box');
    expect(res.qtyBase).toBe(24);
    expect(res.factorToBase).toBe(12);
  });

  it('falls back to satuan match when vendor uomId unknown', async () => {
    const cache = new Map<string, ProductUom[]>();
    cache.set('p1', uoms);
    const res = await resolveLocalUomForGrnLine(
      mockDb(new Map()),
      'sppg',
      'p1',
      { qty: 3, satuan: 'box' },
      cache,
    );
    expect(res.uomId).toBe('local-box');
    expect(res.qtyBase).toBe(36);
  });

  it('uses qtyBase from webhook when provided', async () => {
    const cache = new Map<string, ProductUom[]>();
    cache.set('p1', uoms);
    const res = await resolveLocalUomForGrnLine(
      mockDb(new Map()),
      'sppg',
      'p1',
      { uomId: 'vendor-box', qty: 2, qtyBase: 24 },
      cache,
    );
    expect(res.qtyBase).toBe(24);
  });
});
