import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('uuid', () => ({ v4: () => 'dist-return-sf-uuid-1' }));

import {
  detectDistReturnFefoShortfalls,
  runDistReturnFefoShortfallDetect,
} from '@/lib/api/dist-return-fefo-shortfall-reconcile';

describe('W2-14 Dist Return FEFO Restore Shortfall Detect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags COMPLETED orders with fefoRestore.shortfall > 0', async () => {
    const orders = [
      {
        id: 'dst-1',
        noDokumen: 'DST-1',
        tenantId: 't1',
        status: 'COMPLETED',
        warehouseKode: 'GKERING',
        fefoRestore: [
          {
            stokId: 'fg1',
            needQty: 20,
            restored: 15,
            shortfall: 5,
          },
          {
            stokId: 'fg2',
            needQty: 3,
            restored: 3,
            shortfall: 0,
          },
        ],
      },
      {
        id: 'dst-2',
        noDokumen: 'DST-2',
        tenantId: 't1',
        status: 'COMPLETED',
        warehouseKode: 'GKERING',
        fefoRestore: [
          {
            stokId: 'fg3',
            needQty: 2,
            restored: 2,
            shortfall: 0,
          },
        ],
      },
    ];

    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => orders,
    };
    const db = {
      collection: () => ({ find: () => findCursor }),
    };

    const report = await detectDistReturnFefoShortfalls(db as never, 't1');
    expect(report.summary.scannedOrders).toBe(2);
    expect(report.summary.ordersWithShortfall).toBe(1);
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.summary.shortfallQtyTotal).toBe(5);
    expect(report.mismatches[0]?.kind).toBe('DIST_RETURN_FEFO_SHORTFALL');
    expect(report.mismatches[0]?.restored).toBe(15);
    expect(report.mismatches[0]?.shortfall).toBe(5);
  });

  it('persists report on runDistReturnFefoShortfallDetect', async () => {
    const orders = [
      {
        id: 'dst-x',
        noDokumen: 'DST-X',
        tenantId: 't1',
        status: 'COMPLETED',
        warehouseKode: 'GBASAH',
        fefoRestore: [
          {
            stokId: 'fg1',
            needQty: 8,
            restored: 2,
            shortfall: 6,
          },
        ],
      },
    ];
    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => orders,
    };
    const insertOne = vi.fn(async () => ({ insertedId: 'r1' }));
    const db = {
      collection: (name: string) => {
        if (name === 'distribution_orders') {
          return { find: () => findCursor };
        }
        return { insertOne, find: () => findCursor };
      },
    };

    const report = await runDistReturnFefoShortfallDetect(db as never, 't1');
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.id).toBe('dist-return-sf-uuid-1');
  });
});
