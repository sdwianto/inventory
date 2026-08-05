import { describe, expect, it } from 'vitest';
import { syncCpoFromVendorEvent, syncCpoOnGrnPosted } from '@/lib/api/cpo-status-sync';

function versionMatches(filter: Record<string, unknown>, current: Record<string, unknown>): boolean {
  const ver = Number(current.qtySyncVersion) || 0;
  const or = filter.$or as Array<Record<string, unknown>> | undefined;
  if (!or) return true;
  return or.some((clause) => {
    if (clause.qtySyncVersion && typeof clause.qtySyncVersion === 'object'
      && (clause.qtySyncVersion as { $exists?: boolean }).$exists === false) {
      return current.qtySyncVersion === undefined;
    }
    return Number(clause.qtySyncVersion) === ver;
  });
}

function mockDb(po: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  let current = { ...po };
  const db = {
    collection: (name: string) => ({
      findOne: async () => (name === 'customer_purchase_orders' ? current : null),
      updateOne: async (
        filter: Record<string, unknown>,
        patch: { $set?: Record<string, unknown>; $addToSet?: Record<string, unknown> },
      ) => {
        if (filter.appliedReceiveGrnIds && typeof filter.appliedReceiveGrnIds === 'object') {
          const ne = (filter.appliedReceiveGrnIds as { $ne?: string }).$ne;
          if (ne && Array.isArray(current.appliedReceiveGrnIds) && current.appliedReceiveGrnIds.includes(ne)) {
            return { matchedCount: 0, modifiedCount: 0 };
          }
        }
        if (filter.appliedShipDeliveryIds && typeof filter.appliedShipDeliveryIds === 'object') {
          const ne = (filter.appliedShipDeliveryIds as { $ne?: string }).$ne;
          if (ne && Array.isArray(current.appliedShipDeliveryIds) && current.appliedShipDeliveryIds.includes(ne)) {
            return { matchedCount: 0, modifiedCount: 0 };
          }
        }
        if (!versionMatches(filter, current)) {
          return { matchedCount: 0, modifiedCount: 0 };
        }
        if (patch.$set) {
          updates.push(patch.$set);
          current = { ...current, ...patch.$set };
        }
        if (patch.$addToSet) {
          for (const [key, value] of Object.entries(patch.$addToSet)) {
            const prev = Array.isArray(current[key]) ? [...(current[key] as unknown[])] : [];
            if (!prev.includes(value)) prev.push(value);
            current[key] = prev;
          }
        }
        return { matchedCount: 1, modifiedCount: 1 };
      },
    }),
  };
  return { db, updates, getPo: () => current };
}

describe('syncCpoOnGrnPosted', () => {
  it('sets RECEIVED when all qty received', async () => {
    const po = {
      id: 'po1',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      status: 'SHIPPED',
      items: [{ localStokId: 'p1', kode: 'A', qty: 2, qtyReceived: 0 }],
    };
    const { db, updates } = mockDb(po);
    await syncCpoOnGrnPosted(db as never, {
      id: 'grn-1',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      items: [{ localStokId: 'p1', localKode: 'A', qtyReceived: 2 }],
    });
    expect(updates[0]?.status).toBe('RECEIVED');
    const items = updates[0]?.items as Array<{ qtyReceived: number }>;
    expect(items[0]?.qtyReceived).toBe(2);
  });

  it('reaches RECEIVED when remaining qty is explicitly rejected (not just short-shipped)', async () => {
    const po = {
      id: 'po1',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      status: 'SHIPPED',
      items: [{ localStokId: 'p1', kode: 'A', qty: 10, qtyReceived: 0 }],
    };
    const { db, updates } = mockDb(po);
    await syncCpoOnGrnPosted(db as never, {
      id: 'grn-reject-1',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      items: [{ localStokId: 'p1', localKode: 'A', qtyReceived: 7, qtyRejected: 3 }],
    });
    expect(updates[0]?.status).toBe('RECEIVED');
    const items = updates[0]?.items as Array<{ qtyReceived: number; qtyRejected: number }>;
    expect(items[0]?.qtyReceived).toBe(7);
    expect(items[0]?.qtyRejected).toBe(3);
  });

  it('stays PARTIAL_RECEIVED when rejected qty does not cover the remaining shortfall', async () => {
    const po = {
      id: 'po1',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      status: 'SHIPPED',
      items: [{ localStokId: 'p1', kode: 'A', qty: 10, qtyReceived: 0 }],
    };
    const { db, updates } = mockDb(po);
    await syncCpoOnGrnPosted(db as never, {
      id: 'grn-reject-2',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      items: [{ localStokId: 'p1', localKode: 'A', qtyReceived: 5, qtyRejected: 1 }],
    });
    expect(updates[0]?.status).toBe('PARTIAL_RECEIVED');
  });

  it('preserves INVOICED status when updating receive qty', async () => {
    const po = {
      id: 'po1',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      status: 'INVOICED',
      items: [{ localStokId: 'p1', kode: 'A', qty: 2, qtyReceived: 2 }],
    };
    const { db, updates } = mockDb(po);
    await syncCpoOnGrnPosted(db as never, {
      id: 'grn-2',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      items: [{ localStokId: 'p1', localKode: 'A', qtyReceived: 2 }],
    });
    expect(updates[0]?.status).toBe('INVOICED');
  });

  it('is idempotent for the same GRN id', async () => {
    const po = {
      id: 'po1',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      status: 'SHIPPED',
      items: [{ localStokId: 'p1', kode: 'A', qty: 2, qtyReceived: 0 }],
    };
    const { db, updates, getPo } = mockDb(po);
    const grn = {
      id: 'grn-dup',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      items: [{ localStokId: 'p1', localKode: 'A', qtyReceived: 2 }],
    };
    const first = await syncCpoOnGrnPosted(db as never, grn);
    const second = await syncCpoOnGrnPosted(db as never, grn);
    expect(first.action).toBe('updated');
    expect(second.action).toBe('skipped');
    expect(updates).toHaveLength(1);
    const items = getPo().items as Array<{ qtyReceived: number }>;
    expect(items[0]?.qtyReceived).toBe(2);
  });

  it('skips when grn.id missing', async () => {
    const po = {
      id: 'po1',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      status: 'SHIPPED',
      items: [{ localStokId: 'p1', kode: 'A', qty: 2, qtyReceived: 0 }],
    };
    const { db, updates } = mockDb(po);
    const result = await syncCpoOnGrnPosted(db as never, {
      tenantId: 'sppg',
      noPO: 'CPO-1',
      items: [{ localStokId: 'p1', localKode: 'A', qtyReceived: 2 }],
    });
    expect(result.action).toBe('skipped');
    expect((result as { reason?: string }).reason).toBe('missing_grn_id');
    expect(updates).toHaveLength(0);
  });
});

describe('syncCpoFromVendorEvent delivery.shipped', () => {
  it('is idempotent for the same deliveryId', async () => {
    const po = {
      id: 'po1',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      status: 'CONFIRMED',
      items: [{ localStokId: 'p1', vendorStokId: 'p1', kode: 'A', qty: 2, qtyShipped: 0 }],
    };
    const { db, updates, getPo } = mockDb(po);
    const payload = {
      deliveryId: 'do-1',
      noDO: 'DO001',
      noPO: 'CPO-1',
      items: [{ stokId: 'p1', kode: 'A', qty: 2 }],
    };
    const first = await syncCpoFromVendorEvent(db as never, 'sppg', 'delivery.shipped', payload);
    const second = await syncCpoFromVendorEvent(db as never, 'sppg', 'delivery.shipped', payload);
    expect(first.action).toBe('updated');
    expect(second.action).toBe('skipped');
    expect(updates).toHaveLength(1);
    const items = getPo().items as Array<{ qtyShipped: number }>;
    expect(items[0]?.qtyShipped).toBe(2);
  });

  it('skips when deliveryId missing', async () => {
    const po = {
      id: 'po1',
      tenantId: 'sppg',
      noPO: 'CPO-1',
      status: 'CONFIRMED',
      items: [{ localStokId: 'p1', vendorStokId: 'p1', kode: 'A', qty: 2, qtyShipped: 0 }],
    };
    const { db, updates } = mockDb(po);
    const result = await syncCpoFromVendorEvent(db as never, 'sppg', 'delivery.shipped', {
      noPO: 'CPO-1',
      items: [{ stokId: 'p1', kode: 'A', qty: 2 }],
    });
    expect(result.action).toBe('skipped');
    expect((result as { reason?: string }).reason).toBe('missing_delivery_id');
    expect(updates).toHaveLength(0);
  });
});
