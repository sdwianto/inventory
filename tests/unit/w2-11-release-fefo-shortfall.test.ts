import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('uuid', () => ({ v4: () => 'release-sf-uuid-1' }));

import {
  detectReleaseFefoShortfalls,
  runReleaseFefoShortfallDetect,
} from '@/lib/api/release-fefo-shortfall-reconcile';

describe('W2-11 Release FEFO Shortfall Detect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags POSTED releases with shortfall > 0 and ignores skippedNoBatches', async () => {
    const releases = [
      {
        id: 'rl-1',
        noRelease: 'RL-1',
        tenantId: 't1',
        status: 'POSTED',
        lokasiKode: 'GKERING',
        fefoConsume: [
          {
            stokId: 'fg1',
            allocated: 7,
            shortfall: 3,
            skippedNoBatches: false,
          },
          {
            stokId: 'fg2',
            allocated: 0,
            shortfall: 5,
            skippedNoBatches: true,
          },
        ],
      },
      {
        id: 'rl-2',
        noRelease: 'RL-2',
        tenantId: 't1',
        status: 'POSTED',
        lokasiKode: 'GKERING',
        fefoConsume: [
          {
            stokId: 'fg3',
            allocated: 2,
            shortfall: 0,
            skippedNoBatches: false,
          },
        ],
      },
    ];

    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => releases,
    };
    const db = {
      collection: () => ({ find: () => findCursor }),
    };

    const report = await detectReleaseFefoShortfalls(db as never, 't1');
    expect(report.summary.scannedReleases).toBe(2);
    expect(report.summary.releasesWithShortfall).toBe(1);
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.summary.shortfallQtyTotal).toBe(3);
    expect(report.mismatches[0]?.kind).toBe('RELEASE_FEFO_SHORTFALL');
    expect(report.mismatches[0]?.releaseId).toBe('rl-1');
    expect(report.mismatches[0]?.needQty).toBe(10); // allocated + shortfall
    expect(report.mismatches[0]?.warehouseKode).toBe('GKERING');
  });

  it('persists report on runReleaseFefoShortfallDetect', async () => {
    const releases = [
      {
        id: 'rl-x',
        noRelease: 'RL-X',
        tenantId: 't1',
        status: 'POSTED',
        lokasiKode: 'GBASAH',
        fefoConsume: [
          {
            stokId: 'fg1',
            allocated: 1,
            shortfall: 4,
            skippedNoBatches: false,
          },
        ],
      },
    ];
    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => releases,
    };
    const insertOne = vi.fn(async () => ({ insertedId: 'r1' }));
    const db = {
      collection: (name: string) => {
        if (name === 'inventory_releases') {
          return { find: () => findCursor };
        }
        return { insertOne, find: () => findCursor };
      },
    };

    const report = await runReleaseFefoShortfallDetect(db as never, 't1');
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.id).toBe('release-sf-uuid-1');
  });
});
