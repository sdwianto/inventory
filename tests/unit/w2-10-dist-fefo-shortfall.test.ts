import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('uuid', () => ({ v4: () => 'dist-sf-uuid-1' }));

import {
  detectDistFefoShortfalls,
  runDistFefoShortfallDetect,
} from '@/lib/api/dist-fefo-shortfall-reconcile';

describe('W2-10 Dist FEFO Shortfall Detect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags PROCESSING/COMPLETED orders with shortfall > 0 and ignores skippedNoBatches', async () => {
    const orders = [
      {
        id: 'dst-1',
        noDokumen: 'DST-1',
        tenantId: 't1',
        status: 'PROCESSING',
        warehouseKode: 'GKERING',
        fefoConsume: [
          {
            stokId: 'fg1',
            needQty: 100,
            allocated: 90,
            shortfall: 10,
            skippedNoBatches: false,
          },
          {
            stokId: 'fg2',
            needQty: 20,
            allocated: 0,
            shortfall: 20,
            skippedNoBatches: true,
          },
        ],
      },
      {
        id: 'dst-2',
        noDokumen: 'DST-2',
        tenantId: 't1',
        status: 'COMPLETED',
        warehouseKode: 'GKERING',
        fefoConsume: [
          {
            stokId: 'fg3',
            needQty: 5,
            allocated: 5,
            shortfall: 0,
            skippedNoBatches: false,
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

    const report = await detectDistFefoShortfalls(db as never, 't1');
    expect(report.summary.scannedOrders).toBe(2);
    expect(report.summary.ordersWithShortfall).toBe(1);
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.summary.shortfallQtyTotal).toBe(10);
    expect(report.mismatches[0]?.kind).toBe('DIST_FEFO_SHORTFALL');
    expect(report.mismatches[0]?.distId).toBe('dst-1');
    expect(report.mismatches[0]?.warehouseKode).toBe('GKERING');
  });

  it('persists report on runDistFefoShortfallDetect', async () => {
    const orders = [
      {
        id: 'dst-x',
        noDokumen: 'DST-X',
        tenantId: 't1',
        status: 'COMPLETED',
        warehouseKode: 'GBASAH',
        fefoConsume: [
          {
            stokId: 'fg1',
            needQty: 8,
            allocated: 3,
            shortfall: 5,
            skippedNoBatches: false,
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

    const report = await runDistFefoShortfallDetect(db as never, 't1');
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.id).toBe('dist-sf-uuid-1');
  });
});
