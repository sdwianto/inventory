import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enrichPoItemsForVendor, groupPoItemsByVendorTenant } from '@/lib/api/customer-po-vendor';

vi.mock('@/lib/api/product-uom', () => ({
  findProductUomsByIds: vi.fn(),
  listProductUomsByProductIds: vi.fn(),
}));

import { findProductUomsByIds, listProductUomsByProductIds } from '@/lib/api/product-uom';

const mockedFindUoms = vi.mocked(findProductUomsByIds);
const mockedListUoms = vi.mocked(listProductUomsByProductIds);

function productDb() {
  return {
    collection: (name: string) => ({
      find: () => ({
        toArray: async () => {
          if (name === 'products') {
            return [{
              id: 'lp1',
              tenantId: 'sppg',
              kode: 'A1',
              nama: 'Barang',
              vendorStokId: 'vp1',
              vendorTenantId: 'uddawam',
              syncSource: 'sales.app',
            }];
          }
          return [];
        },
      }),
    }),
  };
}

describe('groupPoItemsByVendorTenant', () => {
  it('groups items by vendorTenantId', () => {
    const result = groupPoItemsByVendorTenant([
      { vendorTenantId: 'v1', kode: 'A', qty: 1 },
      { vendorTenantId: 'v2', kode: 'B', qty: 2 },
      { vendorTenantId: 'v1', kode: 'C', qty: 3 },
    ]);
    expect('groups' in result).toBe(true);
    if (!('groups' in result)) return;
    expect(result.groups).toHaveLength(2);
    expect(result.groups?.find((g) => g.vendorTenantId === 'v1')?.items).toHaveLength(2);
  });

  it('rejects item without vendorTenantId', () => {
    const result = groupPoItemsByVendorTenant([{ kode: 'A', qty: 1 }]);
    expect('error' in result).toBe(true);
  });
});

describe('enrichPoItemsForVendor', () => {
  beforeEach(() => {
    mockedListUoms.mockResolvedValue(new Map());
  });

  it('rejects when local UOM has no vendorUomId', async () => {
    mockedFindUoms.mockResolvedValue(new Map([
      ['local-box', {
        id: 'local-box',
        tenantId: 'sppg',
        productId: 'lp1',
        satuan: 'BOX',
        factorToBase: 10,
        vendorUomId: undefined,
        isBase: false,
        hargaEcer: 0,
        hargaGrosir: 0,
        hargaSpesial: 0,
        barcode: '',
        sortOrder: 1,
        aktif: true,
      }],
    ]));
    mockedListUoms.mockResolvedValue(new Map([
      ['lp1', [{
        id: 'local-box',
        tenantId: 'sppg',
        productId: 'lp1',
        satuan: 'BOX',
        factorToBase: 10,
        vendorUomId: undefined,
        isBase: false,
        hargaEcer: 0,
        hargaGrosir: 0,
        hargaSpesial: 0,
        barcode: '',
        sortOrder: 1,
        aktif: true,
      }]],
    ]));

    const result = await enrichPoItemsForVendor(productDb() as never, 'sppg', [{
      localStokId: 'lp1',
      uomId: 'local-box',
      qty: 2,
      nama: 'Barang',
    }]);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/belum terhubung ke sales/i);
    }
  });

  it('maps vendorUomId for push to sales', async () => {
    mockedFindUoms.mockResolvedValue(new Map([
      ['local-box', {
        id: 'local-box',
        tenantId: 'sppg',
        productId: 'lp1',
        satuan: 'BOX',
        factorToBase: 10,
        vendorUomId: 'vendor-box-id',
        isBase: false,
        hargaEcer: 0,
        hargaGrosir: 0,
        hargaSpesial: 0,
        barcode: '',
        sortOrder: 1,
        aktif: true,
      }],
    ]));
    mockedListUoms.mockResolvedValue(new Map([
      ['lp1', [{
        id: 'local-box',
        tenantId: 'sppg',
        productId: 'lp1',
        satuan: 'BOX',
        factorToBase: 10,
        vendorUomId: 'vendor-box-id',
        isBase: false,
        hargaEcer: 0,
        hargaGrosir: 0,
        hargaSpesial: 0,
        barcode: '',
        sortOrder: 1,
        aktif: true,
      }]],
    ]));

    const result = await enrichPoItemsForVendor(productDb() as never, 'sppg', [{
      localStokId: 'lp1',
      uomId: 'local-box',
      qty: 2,
      nama: 'Barang',
    }]);

    expect('items' in result).toBe(true);
    if ('items' in result) {
      expect(result.items?.[0]?.uomId).toBe('vendor-box-id');
      expect(result.items?.[0]?.satuan).toBe('BOX');
    }
  });

  it('falls back to legacy vendor uom id for synced base PCS', async () => {
    mockedFindUoms.mockResolvedValue(new Map([
      ['stale-uom', {
        id: 'stale-uom',
        tenantId: 'sppg',
        productId: 'lp1',
        satuan: 'PCS',
        factorToBase: 1,
        vendorUomId: undefined,
        isBase: true,
        hargaEcer: 0,
        hargaGrosir: 0,
        hargaSpesial: 0,
        barcode: '',
        sortOrder: 0,
        aktif: true,
      }],
    ]));
    mockedListUoms.mockResolvedValue(new Map([
      ['lp1', [{
        id: 'new-pcs',
        tenantId: 'sppg',
        productId: 'lp1',
        satuan: 'PCS',
        factorToBase: 1,
        vendorUomId: undefined,
        isBase: true,
        hargaEcer: 0,
        hargaGrosir: 0,
        hargaSpesial: 0,
        barcode: '',
        sortOrder: 0,
        aktif: true,
      }]],
    ]));

    const result = await enrichPoItemsForVendor(productDb() as never, 'sppg', [{
      localStokId: 'lp1',
      uomId: 'stale-uom',
      qty: 1,
      nama: 'Jeruk Siem',
      satuan: 'PCS',
    }]);

    // legacy: tanpa Sync Katalog penuh ditolak di sisi inventory (sales menolak uomId tidak dikenal)
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/Sync Katalog/i);
    }
  });

  it('uses vendorBaseUomId from product when product_uom belum punya vendorUomId', async () => {
    const dbWithBase = {
      collection: (name: string) => ({
        find: () => ({
          toArray: async () => {
            if (name === 'products') {
              return [{
                id: 'lp1',
                tenantId: 'sppg',
                kode: 'A1',
                nama: 'Barang',
                satuan: 'KG',
                vendorStokId: 'vp1',
                vendorTenantId: 'uddawam',
                vendorBaseUomId: 'sales-uom-kg-1',
                syncSource: 'sales.app',
              }];
            }
            return [];
          },
        }),
      }),
    };
    mockedFindUoms.mockResolvedValue(new Map([
      ['local-kg', {
        id: 'local-kg',
        tenantId: 'sppg',
        productId: 'lp1',
        satuan: 'KG',
        factorToBase: 1,
        vendorUomId: undefined,
        isBase: true,
        hargaEcer: 0,
        hargaGrosir: 0,
        hargaSpesial: 0,
        barcode: '',
        sortOrder: 0,
        aktif: true,
      }],
    ]));
    mockedListUoms.mockResolvedValue(new Map([
      ['lp1', [{
        id: 'local-kg',
        tenantId: 'sppg',
        productId: 'lp1',
        satuan: 'KG',
        factorToBase: 1,
        vendorUomId: undefined,
        isBase: true,
        hargaEcer: 0,
        hargaGrosir: 0,
        hargaSpesial: 0,
        barcode: '',
        sortOrder: 0,
        aktif: true,
      }]],
    ]));

    const result = await enrichPoItemsForVendor(dbWithBase as never, 'sppg', [{
      localStokId: 'lp1',
      uomId: 'local-kg',
      qty: 135,
      nama: 'Ayam Fillet',
      satuan: 'KG',
    }]);

    expect('items' in result).toBe(true);
    if ('items' in result) {
      expect(result.items?.[0]?.uomId).toBe('sales-uom-kg-1');
      expect(result.items?.[0]?.satuan).toBe('KG');
    }
  });

  it('prefers line vendorUomId over stale local mapping', async () => {
    mockedFindUoms.mockResolvedValue(new Map([
      ['local-kg', {
        id: 'local-kg',
        tenantId: 'sppg',
        productId: 'lp1',
        satuan: 'KG',
        factorToBase: 1,
        vendorUomId: 'legacy:vp1',
        isBase: true,
        hargaEcer: 0,
        hargaGrosir: 0,
        hargaSpesial: 0,
        barcode: '',
        sortOrder: 0,
        aktif: true,
      }],
    ]));
    mockedListUoms.mockResolvedValue(new Map([
      ['lp1', [{
        id: 'local-kg',
        tenantId: 'sppg',
        productId: 'lp1',
        satuan: 'KG',
        factorToBase: 1,
        vendorUomId: 'legacy:vp1',
        isBase: true,
        hargaEcer: 0,
        hargaGrosir: 0,
        hargaSpesial: 0,
        barcode: '',
        sortOrder: 0,
        aktif: true,
      }]],
    ]));

    const result = await enrichPoItemsForVendor(productDb() as never, 'sppg', [{
      localStokId: 'lp1',
      uomId: 'local-kg',
      vendorUomId: 'sales-real-uom',
      qty: 10,
      satuan: 'KG',
      nama: 'Barang',
    }]);

    expect('items' in result).toBe(true);
    if ('items' in result) {
      expect(result.items?.[0]?.uomId).toBe('sales-real-uom');
    }
  });

  it('ignores stale line vendorUomId when catalog already has real mappings', async () => {
    mockedFindUoms.mockResolvedValue(new Map([
      ['local-kg', {
        id: 'local-kg',
        tenantId: 'sppg',
        productId: 'lp1',
        satuan: 'KG',
        factorToBase: 10,
        vendorUomId: 'sales-kg-current',
        isBase: false,
        hargaEcer: 0,
        hargaGrosir: 0,
        hargaSpesial: 0,
        barcode: '',
        sortOrder: 1,
        aktif: true,
      }],
    ]));
    mockedListUoms.mockResolvedValue(new Map([
      ['lp1', [
        {
          id: 'local-ons',
          tenantId: 'sppg',
          productId: 'lp1',
          satuan: 'ONS',
          factorToBase: 1,
          vendorUomId: 'sales-ons-current',
          isBase: true,
          hargaEcer: 0,
          hargaGrosir: 0,
          hargaSpesial: 0,
          barcode: '',
          sortOrder: 0,
          aktif: true,
        },
        {
          id: 'local-kg',
          tenantId: 'sppg',
          productId: 'lp1',
          satuan: 'KG',
          factorToBase: 10,
          vendorUomId: 'sales-kg-current',
          isBase: false,
          hargaEcer: 0,
          hargaGrosir: 0,
          hargaSpesial: 0,
          barcode: '',
          sortOrder: 1,
          aktif: true,
        },
      ]],
    ]));

    const result = await enrichPoItemsForVendor(productDb() as never, 'sppg', [{
      localStokId: 'lp1',
      uomId: 'local-kg',
      vendorUomId: 'sales-uom-deleted-long-ago',
      qty: 2,
      satuan: 'KG',
      nama: 'Daging Sapi',
    }]);

    expect('items' in result).toBe(true);
    if ('items' in result) {
      expect(result.items?.[0]?.uomId).toBe('sales-kg-current');
      expect(result.items?.[0]?.satuan).toBe('KG');
    }
  });

  it('rejects inactive synced product', async () => {
    const inactiveDb = {
      collection: (name: string) => ({
        find: () => ({
          toArray: async () => {
            if (name === 'products') {
              return [{
                id: 'lp1',
                tenantId: 'sppg',
                kode: 'B872426',
                nama: 'Tempe Kecil',
                vendorStokId: 'vp-old',
                vendorTenantId: 'abiliyan',
                syncSource: 'sales.app',
                aktif: false,
              }];
            }
            return [];
          },
        }),
      }),
    };

    const result = await enrichPoItemsForVendor(inactiveDb as never, 'sppg', [{
      localStokId: 'lp1',
      qty: 1,
      nama: 'Tempe Kecil',
    }]);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/tidak aktif/i);
      expect(result.error).toMatch(/Edit PO|Sync Katalog/i);
    }
  });
});
