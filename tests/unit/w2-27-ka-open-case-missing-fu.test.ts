import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'missing-fu-uuid-1'),
}));

import { KA_FOLLOW_UPS_COLLECTION } from '@/lib/kitchen-assurance/follow-up';
import { KA_SAFETY_CASES_COLLECTION } from '@/lib/kitchen-assurance/safety-case';
import {
  detectKaOpenCaseMissingFu,
  KA_OPEN_CASE_MISSING_FU_RECONCILE_REPORTS_COLLECTION,
  runKaOpenCaseMissingFuDetect,
} from '@/lib/api/ka-open-case-missing-fu-reconcile';

type CaseRow = {
  id: string;
  tenantId: string;
  noDokumen: string;
  status: string;
  resolution?: { type?: string };
  updatedAt?: Date;
};

type FuRow = {
  id: string;
  tenantId: string;
  safetyCaseId?: string;
  status: string;
};

function mockDb(opts: { cases: CaseRow[]; followUps: FuRow[] }) {
  const insertOne = vi.fn(async () => ({ insertedId: 'x' }));

  return {
    insertOne,
    db: {
      collection: (name: string) => {
        if (name === KA_SAFETY_CASES_COLLECTION) {
          const cursor = {
            sort: () => cursor,
            limit: () => cursor,
            toArray: async () =>
              opts.cases.filter(
                (c) =>
                  c.tenantId === 't1'
                  && ['OPEN', 'IN_PROGRESS', 'PENDING_VERIFY'].includes(c.status)
                  && c.resolution?.type === 'FOLLOW_UP',
              ),
          };
          return { find: () => cursor };
        }
        if (name === KA_FOLLOW_UPS_COLLECTION) {
          return {
            find: (filter: Record<string, unknown>) => {
              const ids = (filter.safetyCaseId as { $in?: string[] } | undefined)?.$in || [];
              const cursor = {
                project: () => cursor,
                toArray: async () =>
                  opts.followUps.filter(
                    (f) =>
                      f.tenantId === 't1'
                      && Boolean(f.safetyCaseId)
                      && ids.includes(String(f.safetyCaseId)),
                  ),
              };
              return cursor;
            },
          };
        }
        if (name === KA_OPEN_CASE_MISSING_FU_RECONCILE_REPORTS_COLLECTION) {
          return { insertOne };
        }
        return { insertOne };
      },
    },
  };
}

describe('W2-27 KA open-case missing FU detect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags open FOLLOW_UP case with zero FU', async () => {
    const { db } = mockDb({
      cases: [{
        id: 'sc1',
        tenantId: 't1',
        noDokumen: 'SCF-1',
        status: 'OPEN',
        resolution: { type: 'FOLLOW_UP' },
      }],
      followUps: [],
    });

    const report = await detectKaOpenCaseMissingFu(db as never, 't1');
    expect(report.summary.scannedCases).toBe(1);
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.summary.zeroFu).toBe(1);
    expect(report.summary.onlyTerminalFu).toBe(0);
    expect(report.mismatches[0]).toMatchObject({
      kind: 'CASE_FOLLOW_UP_ZERO_FU',
      safetyCaseId: 'sc1',
      fuTotalCount: 0,
      fuActiveCount: 0,
    });
  });

  it('flags open FOLLOW_UP case with only CANCELLED FU', async () => {
    const { db } = mockDb({
      cases: [{
        id: 'sc2',
        tenantId: 't1',
        noDokumen: 'SCF-2',
        status: 'IN_PROGRESS',
        resolution: { type: 'FOLLOW_UP' },
      }],
      followUps: [{
        id: 'fu-c',
        tenantId: 't1',
        safetyCaseId: 'sc2',
        status: 'CANCELLED',
      }],
    });

    const report = await detectKaOpenCaseMissingFu(db as never, 't1');
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.summary.onlyTerminalFu).toBe(1);
    expect(report.mismatches[0]).toMatchObject({
      kind: 'CASE_FOLLOW_UP_ONLY_TERMINAL_FU',
      safetyCaseId: 'sc2',
      fuTotalCount: 1,
      fuActiveCount: 0,
    });
  });

  it('has no mismatch when OPEN FU exists', async () => {
    const { db } = mockDb({
      cases: [{
        id: 'sc3',
        tenantId: 't1',
        noDokumen: 'SCF-3',
        status: 'PENDING_VERIFY',
        resolution: { type: 'FOLLOW_UP' },
      }],
      followUps: [{
        id: 'fu-open',
        tenantId: 't1',
        safetyCaseId: 'sc3',
        status: 'OPEN',
      }],
    });

    const report = await detectKaOpenCaseMissingFu(db as never, 't1');
    expect(report.summary.scannedCases).toBe(1);
    expect(report.summary.totalMismatch).toBe(0);
    expect(report.mismatches).toEqual([]);
  });

  it('does not scan CLOSED case', async () => {
    const { db } = mockDb({
      cases: [{
        id: 'sc-closed',
        tenantId: 't1',
        noDokumen: 'SCF-C',
        status: 'CLOSED',
        resolution: { type: 'FOLLOW_UP' },
      }],
      followUps: [],
    });

    const report = await detectKaOpenCaseMissingFu(db as never, 't1');
    expect(report.summary.scannedCases).toBe(0);
    expect(report.summary.totalMismatch).toBe(0);
  });

  it('does not flag resolution NONE', async () => {
    const { db } = mockDb({
      cases: [{
        id: 'sc-none',
        tenantId: 't1',
        noDokumen: 'SCF-N',
        status: 'OPEN',
        resolution: { type: 'NONE' },
      }],
      followUps: [],
    });

    const report = await detectKaOpenCaseMissingFu(db as never, 't1');
    expect(report.summary.scannedCases).toBe(0);
    expect(report.summary.totalMismatch).toBe(0);
  });

  it('runKaOpenCaseMissingFuDetect persists a report', async () => {
    const { db, insertOne } = mockDb({
      cases: [{
        id: 'sc4',
        tenantId: 't1',
        noDokumen: 'SCF-4',
        status: 'OPEN',
        resolution: { type: 'FOLLOW_UP' },
      }],
      followUps: [],
    });

    const report = await runKaOpenCaseMissingFuDetect(db as never, 't1');
    expect(report.summary.zeroFu).toBe(1);
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(insertOne.mock.calls[0][0]).toMatchObject({
      id: 'missing-fu-uuid-1',
      tenantId: 't1',
      summary: expect.objectContaining({ totalMismatch: 1, zeroFu: 1 }),
    });
  });
});
