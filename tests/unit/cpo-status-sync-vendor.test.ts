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

  it('marks single PO line on sales_order.cancelled webhook without cancelling whole PO', async () => {
    const multiItemPo = {
      ...basePo,
      status: 'CONFIRMED',
      items: [
        { lineId: 'l1', kode: 'B553057', nama: 'Abon', qty: 1, vendorTenantId: 'uddawam' },
        { lineId: 'l2', kode: 'B711755', nama: 'Tempe', qty: 1, vendorTenantId: 'tempe' },
      ],
    };
    const { db, updates } = mockDb(multiItemPo);
    await syncCpoFromVendorEvent(db as never, 'sppg', 'sales_order.cancelled', {
      customerPoId: 'cpo-1',
      salesOrderId: 'so-tempe',
      noSO: 'SO001',
      vendorTenantId: 'tempe',
      cancelledItems: [{ kode: 'B711755', qty: 1, reason: 'Item terakhir dibatalkan' }],
      reason: 'Semua item dibatalkan',
    });
    expect(updates[0]?.status).toBe('PARTIAL_CANCELLED');
    const items = updates[0]?.items as Array<{ kode?: string; cancelled?: boolean }>;
    expect(items.find((r) => r.kode === 'B711755')?.cancelled).toBe(true);
    expect(items.find((r) => r.kode === 'B553057')?.cancelled).toBeFalsy();
  });

  it('does not mark other vendors CANCELLED just because they share the same noSO number', async () => {
    const multiVendorPo = {
      ...basePo,
      status: 'CONFIRMED',
      items: [
        { lineId: 'l1', kode: 'B553057', nama: 'Abon', qty: 1, vendorTenantId: 'uddawam' },
        { lineId: 'l2', kode: 'B711755', nama: 'Tempe', qty: 1, vendorTenantId: 'zulmy' },
      ],
      vendorSubmissions: [
        { vendorTenantId: 'uddawam', vendorSoId: 'so-uddawam-1', vendorNoSO: 'SO2608000001', status: 'CONFIRMED' },
        { vendorTenantId: 'zulmy', vendorSoId: 'so-zulmy-1', vendorNoSO: 'SO2608000001', status: 'CONFIRMED' },
      ],
    };
    const { db, updates } = mockDb(multiVendorPo);
    await syncCpoFromVendorEvent(db as never, 'sppg', 'sales_order.cancelled', {
      customerPoId: 'cpo-1',
      salesOrderId: 'so-uddawam-1',
      noSO: 'SO2608000001',
      vendorTenantId: 'uddawam',
      cancelledItems: [{ kode: 'B553057', qty: 1, reason: 'so ulANG' }],
      reason: 'so ulANG',
    });
    const subs = updates[0]?.vendorSubmissions as Array<{ vendorTenantId?: string; status?: string }>;
    expect(subs.find((s) => s.vendorTenantId === 'uddawam')?.status).toBe('CANCELLED');
    expect(subs.find((s) => s.vendorTenantId === 'zulmy')?.status).toBe('CONFIRMED');
  });

  it('marks all PO lines on sales_order.cancelled when every line cancelled', async () => {
    const singleItemPo = {
      ...basePo,
      items: [{ lineId: 'l1', kode: 'B711755', nama: 'Tempe', qty: 1 }],
    };
    const { db, updates } = mockDb(singleItemPo);
    await syncCpoFromVendorEvent(db as never, 'sppg', 'sales_order.cancelled', {
      customerPoId: 'cpo-1',
      salesOrderId: 'so-1',
      noSO: 'SO001',
      cancelledItems: [{ kode: 'B711755', qty: 1, reason: 'Item terakhir dibatalkan' }],
      reason: 'Semua item dibatalkan',
    });
    expect(updates[0]?.status).toBe('CANCELLED');
    const items = updates[0]?.items as Array<{ kode?: string; cancelled?: boolean }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.cancelled).toBe(true);
    expect((updates[0]?.cancelledSoLines as unknown[])?.length).toBeGreaterThan(0);
  });
});
