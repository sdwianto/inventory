import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/document-sequence', () => ({
  nextDocNumber: vi.fn(async () => 'GRN-NEW'),
}));

vi.mock('@/lib/api/grn-resolve-products', () => ({
  loadProductMaps: vi.fn(async () => ({
    byVendorStokId: new Map(),
    byKode: new Map(),
    byVendorKode: new Map(),
  })),
  resolveFromMaps: vi.fn((_maps: unknown, _vid: unknown, keys: { vendorStokId?: string; kode?: string }) => ({
    localStokId: keys.vendorStokId ? 'lp1' : null,
    localKode: keys.kode || 'A1',
    localNama: 'Barang',
  })),
}));

vi.mock('@/lib/api/product-uom', () => ({
  listProductUoms: vi.fn(async () => [{
    id: 'local-box',
    tenantId: 'sppg',
    productId: 'lp1',
    satuan: 'BOX',
    isBase: false,
    factorToBase: 10,
    vendorUomId: 'vendor-box',
    hargaEcer: 0,
    hargaGrosir: 0,
    hargaSpesial: 0,
    barcode: '',
    sortOrder: 1,
    aktif: true,
  }]),
}));

vi.mock('@/lib/api/grn-enrich', () => ({
  resolveVendorTenantName: vi.fn(async () => 'Vendor'),
}));

import { createGrnFromDelivery } from '@/lib/api/grn-from-webhook';

describe('createGrnFromDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes items on existing DRAFT GRN', async () => {
    const existing = {
      id: 'grn-1',
      tenantId: 'sppg',
      status: 'DRAFT',
      noGRN: 'GRN-OLD',
      vendorDeliveryId: 'do-1',
      items: [{ lineId: 'l1', qtyOrdered: 1, qtyBase: 1 }],
    };
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      collection: (name: string) => ({
        findOne: async () => (name === 'goods_receipts' ? existing : null),
        updateOne: async (_f: unknown, patch: { $set: Record<string, unknown> }) => {
          updates.push(patch.$set);
        },
        insertOne: async () => ({}),
        find: () => ({ sort: () => ({ toArray: async () => [] }) }),
      }),
    };

    const payload = {
      deliveryId: 'do-1',
      noDO: 'DO-1',
      items: [{
        lineId: 'l1',
        stokId: 'vp1',
        kode: 'A1',
        qty: 2,
        qtyBase: 20,
        uomId: 'vendor-box',
        satuan: 'BOX',
        harga: 5000,
      }],
    };

    const result = await createGrnFromDelivery(db as never, 'sppg', payload, 'uddawam');
    expect(updates[0]?.items).toBeDefined();
    const line = (updates[0]?.items as Array<Record<string, unknown>>)?.[0];
    expect(line?.qtyBase).toBe(20);
    expect(line?.qtyOrdered).toBe(2);
    expect(result.status).toBe('DRAFT');
  });

  it('does not refresh items on POSTED GRN', async () => {
    const existing = {
      id: 'grn-1',
      tenantId: 'sppg',
      status: 'POSTED',
      noGRN: 'GRN-OLD',
      vendorDeliveryId: 'do-1',
      items: [{ qtyOrdered: 1, qtyBase: 1 }],
    };
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      collection: (name: string) => ({
        findOne: async () => (name === 'goods_receipts' ? existing : null),
        updateOne: async (_f: unknown, patch: { $set: Record<string, unknown> }) => {
          updates.push(patch.$set);
        },
        insertOne: async () => ({}),
        find: () => ({ sort: () => ({ toArray: async () => [] }) }),
      }),
    };

    await createGrnFromDelivery(db as never, 'sppg', {
      deliveryId: 'do-1',
      items: [{ stokId: 'vp1', kode: 'A1', qty: 2, qtyBase: 20, uomId: 'vendor-box' }],
    }, 'uddawam');

    expect(updates[0]?.items).toBeUndefined();
  });
});
