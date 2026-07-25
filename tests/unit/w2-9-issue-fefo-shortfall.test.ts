import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('uuid', () => ({ v4: () => 'issue-sf-uuid-1' }));

import {
  detectIssueFefoShortfalls,
  runIssueFefoShortfallDetect,
} from '@/lib/api/issue-fefo-shortfall-reconcile';

describe('W2-9 Issue FEFO Shortfall Detect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags COMPLETED issues with shortfall > 0 and ignores skippedNoLots', async () => {
    const issues = [
      {
        id: 'iss-1',
        noDokumen: 'PBL-1',
        tenantId: 't1',
        status: 'COMPLETED',
        fefoConsume: [
          {
            stokId: 'p1',
            warehouseKode: 'GKERING',
            needQty: 10,
            allocated: 7,
            shortfall: 3,
            skippedNoLots: false,
          },
          {
            stokId: 'p2',
            warehouseKode: 'GKERING',
            needQty: 5,
            allocated: 0,
            shortfall: 5,
            skippedNoLots: true,
          },
        ],
      },
      {
        id: 'iss-2',
        noDokumen: 'PBL-2',
        tenantId: 't1',
        status: 'COMPLETED',
        fefoConsume: [
          {
            stokId: 'p3',
            warehouseKode: 'GBASAH',
            needQty: 2,
            allocated: 2,
            shortfall: 0,
            skippedNoLots: false,
          },
        ],
      },
    ];

    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => issues,
    };
    const db = {
      collection: () => ({ find: () => findCursor }),
    };

    const report = await detectIssueFefoShortfalls(db as never, 't1');
    expect(report.summary.scannedIssues).toBe(2);
    expect(report.summary.issuesWithShortfall).toBe(1);
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.summary.shortfallQtyTotal).toBe(3);
    expect(report.mismatches[0]?.kind).toBe('ISSUE_FEFO_SHORTFALL');
    expect(report.mismatches[0]?.issueId).toBe('iss-1');
    expect(report.mismatches[0]?.shortfall).toBe(3);
  });

  it('persists report on runIssueFefoShortfallDetect', async () => {
    const issues = [
      {
        id: 'iss-x',
        noDokumen: 'PBL-X',
        tenantId: 't1',
        status: 'COMPLETED',
        fefoConsume: [
          {
            stokId: 'p1',
            warehouseKode: 'GKERING',
            needQty: 4,
            allocated: 1,
            shortfall: 3,
            skippedNoLots: false,
          },
        ],
      },
    ];
    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => issues,
    };
    const insertOne = vi.fn(async () => ({ insertedId: 'r1' }));
    const db = {
      collection: (name: string) => {
        if (name === 'material_issues') {
          return { find: () => findCursor };
        }
        return { insertOne, find: () => findCursor };
      },
    };

    const report = await runIssueFefoShortfallDetect(db as never, 't1');
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.id).toBeTruthy();
  });
});
