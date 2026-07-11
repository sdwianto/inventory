import { describe, expect, it } from 'vitest';
import { syncCpoFromVendorEvent } from '@/lib/api/cpo-status-sync';

function mockDb(po: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    collection: (name: string) => ({
      findOne: async () => (name === 'customer_purchase_orders' ? po : null),
      updateOne: async (_filter: unknown, patch: { $set: Record<string, unknown> }) => {
        updates.push(patch.$set);
        Object.assign(po, patch.$set);
      },
    }),
  };
  return { db, updates, po };
}

describe('syncCpoFromVendorEvent', () => {
  const basePo = {
    id: 'cpo-1',
    tenantId: 'sppg',
    noPO: 'CPO-1',
    status: 'SUBMITTED',
    vendorSoId: 'so-1',
    vendorNoSO: 'SO001',
    items: [
      { lineId: 'l1', kode: 'A', nama: 'Jeruk', qty: 2 },
      { lineId: 'l2', kode: 'B', nama: 'Mangga', qty: 1 },
    ],
  };

  it('keeps PARTIAL_CANCELLED on sales_order.confirmed when payload has cancelled lines', async () => {
    const { db, updates } = mockDb({ ...basePo });
    await syncCpoFromVendorEvent(db as never, 'sppg', 'sales_order.confirmed', {
      customerPoId: 'cpo-1',
      salesOrderId: 'so-1',
      noSO: 'SO001',
      items: [{ kode: 'B', qty: 1 }],
      cancelledLine: { kode: 'A', qty: 2, reason: 'Stok habis' },
    });
    expect(updates[0]?.status).toBe('PARTIAL_CANCELLED');
    const items = updates[0]?.items as Array<{ kode?: string; cancelled?: boolean }>;
    expect(items.find((r) => r.kode === 'A')?.cancelled).toBe(true);
    expect(items.find((r) => r.kode === 'B')?.cancelled).toBeFalsy();
  });

  it('rollup ship status ignores cancelled lines', async () => {
    const po = {
      ...basePo,
      status: 'PARTIAL_CANCELLED',
      items: [
        { lineId: 'l1', kode: 'A', qty: 2, cancelled: true, qtyOriginal: 2 },
        { lineId: 'l2', kode: 'B', qty: 1, qtyShipped: 1 },
      ],
    };
    const { db, updates } = mockDb(po);
    await syncCpoFromVendorEvent(db as never, 'sppg', 'delivery.shipped', {
      customerPoId: 'cpo-1',
      items: [{ kode: 'B', qty: 1 }],
    });
    expect(updates[0]?.status).toBe('SHIPPED');
  });
});
