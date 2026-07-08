import { describe, expect, it } from 'vitest';
import { syncCpoOnGrnPosted } from '@/lib/api/cpo-status-sync';

function mockDb(po: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    collection: (name: string) => ({
      findOne: async () => (name === 'customer_purchase_orders' ? po : null),
      updateOne: async (_filter: unknown, patch: { $set: Record<string, unknown> }) => {
        updates.push(patch.$set);
      },
    }),
  };
  return { db, updates };
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
      tenantId: 'sppg',
      noPO: 'CPO-1',
      items: [{ localStokId: 'p1', localKode: 'A', qtyReceived: 2 }],
    });
    expect(updates[0]?.status).toBe('RECEIVED');
    const items = updates[0]?.items as Array<{ qtyReceived: number }>;
    expect(items[0]?.qtyReceived).toBe(2);
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
      tenantId: 'sppg',
      noPO: 'CPO-1',
      items: [{ localStokId: 'p1', localKode: 'A', qtyReceived: 2 }],
    });
    expect(updates[0]?.status).toBe('INVOICED');
  });
});
