import { describe, expect, it } from 'vitest';
import { correctInvoiceItemsAgainstGrn } from '@/lib/api/hutang-from-vendor';
import type { VendorInvoicePayload } from '@/types/integration';

function stubDb(grns: Record<string, unknown>[]) {
  return {
    collection: (name: string) => ({
      find: (query: Record<string, unknown>) => ({
        toArray: async () => {
          if (name !== 'goods_receipts') return [];
          return grns.filter((g) => (
            g.noDO === query.noDO
            && g.status === query.status
            && (!query.vendorTenantId || g.vendorTenantId === query.vendorTenantId)
          ));
        },
      }),
    }),
  } as unknown as import('mongodb').Db;
}

function basePayload(overrides: Partial<VendorInvoicePayload> = {}): VendorInvoicePayload {
  return {
    invoiceId: 'inv-1',
    noInvoice: 'INV2608000011',
    noDO: 'DO2608000011',
    total: 40000,
    subTotal: 40000,
    items: [{ lineId: 'line-1', kode: 'B203740', nama: 'Kelengkeng', qty: 1, harga: 40000, satuan: 'PCS' }],
    ...overrides,
  } as VendorInvoicePayload;
}

describe('correctInvoiceItemsAgainstGrn', () => {
  it('tidak koreksi apa pun kalau payload tanpa noDO', async () => {
    const db = stubDb([]);
    const payload = basePayload({ noDO: undefined });
    const result = await correctInvoiceItemsAgainstGrn(db, 'sppg', payload);
    expect(result.corrected).toBe(false);
    expect(result.items).toEqual(payload.items);
    expect(result.total).toBe(40000);
  });

  it('tidak koreksi kalau tidak ada GRN POSTED untuk noDO tersebut', async () => {
    const db = stubDb([]);
    const payload = basePayload();
    const result = await correctInvoiceItemsAgainstGrn(db, 'sppg', payload);
    expect(result.corrected).toBe(false);
    expect(result.grn).toBeNull();
  });

  it('mengoreksi qty/total ke 0 kalau baris GRN menunjukkan qtyReceived=0 (item ditolak penuh) — kasus INV2608000011/GRN2608000019', async () => {
    const db = stubDb([{
      noDO: 'DO2608000011',
      status: 'POSTED',
      items: [{ lineId: 'line-1', qtyOrdered: 1, qtyReceived: 0, qtyRejected: 1, harga: 40000 }],
    }]);
    const payload = basePayload();
    const result = await correctInvoiceItemsAgainstGrn(db, 'sppg', payload);
    expect(result.corrected).toBe(true);
    expect(result.total).toBe(0);
    expect(result.items[0].qty).toBe(0);
  });

  it('tidak menandai corrected kalau qty invoice sudah sama dengan qtyReceived GRN', async () => {
    const db = stubDb([{
      noDO: 'DO2608000011',
      status: 'POSTED',
      items: [{ lineId: 'line-1', qtyOrdered: 1, qtyReceived: 1, qtyRejected: 0, harga: 40000 }],
    }]);
    const payload = basePayload();
    const result = await correctInvoiceItemsAgainstGrn(db, 'sppg', payload);
    expect(result.corrected).toBe(false);
    expect(result.total).toBe(40000);
  });

  it('menjumlahkan item dari beberapa GRN POSTED untuk noDO yang sama (partial shipment)', async () => {
    const db = stubDb([
      {
        noDO: 'DO2608000011',
        status: 'POSTED',
        items: [{ lineId: 'line-1', qtyOrdered: 3, qtyReceived: 2, qtyRejected: 0, harga: 40000 }],
      },
      {
        noDO: 'DO2608000011',
        status: 'POSTED',
        items: [{ lineId: 'line-2', qtyOrdered: 1, qtyReceived: 0, qtyRejected: 1, harga: 40000 }],
      },
    ]);
    const payload = basePayload({
      total: 160000,
      items: [
        { lineId: 'line-1', kode: 'B203740', nama: 'Kelengkeng', qty: 3, harga: 40000, satuan: 'PCS' },
        { lineId: 'line-2', kode: 'B203740', nama: 'Kelengkeng', qty: 1, harga: 40000, satuan: 'PCS' },
      ],
    });
    const result = await correctInvoiceItemsAgainstGrn(db, 'sppg', payload);
    expect(result.corrected).toBe(true);
    expect(result.items.find((it) => it.lineId === 'line-1')?.qty).toBe(2);
    expect(result.items.find((it) => it.lineId === 'line-2')?.qty).toBe(0);
    expect(result.total).toBe(80000);
  });
});
