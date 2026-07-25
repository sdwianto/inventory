import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'orphan-uuid-1'),
}));

const writeAuditLog = vi.fn(async () => undefined);

vi.mock('@/lib/api/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

import { KA_FOLLOW_UPS_COLLECTION } from '@/lib/kitchen-assurance/follow-up';
import { KA_SAFETY_CASES_COLLECTION } from '@/lib/kitchen-assurance/safety-case';
import {
  detectKaFollowUpOrphans,
  KA_FOLLOW_UP_ORPHAN_RECONCILE_REPORTS_COLLECTION,
  repairKaFollowUpOrphans,
  runKaFollowUpOrphanDetect,
} from '@/lib/api/ka-follow-up-orphan-reconcile';

type FuRow = {
  id: string;
  tenantId: string;
  noDokumen: string;
  safetyCaseId?: string;
  status: string;
  history?: unknown[];
  updatedAt?: Date;
};

type CaseRow = {
  id: string;
  tenantId: string;
  noDokumen: string;
  status: string;
};

function mockDb(opts: {
  followUps: FuRow[];
  cases: CaseRow[];
  onFuUpdate?: (filter: Record<string, unknown>, update: Record<string, unknown>) => void;
}) {
  const insertOne = vi.fn(async () => ({ insertedId: 'x' }));
  const updateOne = vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    opts.onFuUpdate?.(filter, update);
    const id = String(filter.id || '');
    const statusFilter = filter.status;
    const row = opts.followUps.find((f) => f.id === id);
    if (!row) return { modifiedCount: 0 };
    if (typeof statusFilter === 'string' && row.status !== statusFilter) {
      return { modifiedCount: 0 };
    }
    if (statusFilter && typeof statusFilter === 'object' && '$in' in statusFilter) {
      const allowed = (statusFilter as { $in: string[] }).$in;
      if (!allowed.includes(row.status)) return { modifiedCount: 0 };
    }
    const set = (update.$set || {}) as Partial<FuRow>;
    Object.assign(row, set);
    return { modifiedCount: 1 };
  });

  const findOne = vi.fn(async (filter: Record<string, unknown>) => {
    const id = String(filter.id || '');
    const row = opts.followUps.find((f) => f.id === id && f.tenantId === filter.tenantId);
    if (!row) return null;
    const statusFilter = filter.status;
    if (statusFilter && typeof statusFilter === 'object' && '$in' in statusFilter) {
      const allowed = (statusFilter as { $in: string[] }).$in;
      if (!allowed.includes(row.status)) return null;
    }
    return { ...row, history: row.history || [] };
  });

  return {
    insertOne,
    updateOne,
    findOne,
    db: {
      collection: (name: string) => {
        if (name === KA_FOLLOW_UPS_COLLECTION) {
          const cursor = {
            sort: () => cursor,
            limit: () => cursor,
            toArray: async () =>
              opts.followUps.filter((f) => f.tenantId === 't1' && ['OPEN', 'DONE'].includes(f.status)),
          };
          return {
            find: () => cursor,
            findOne,
            updateOne,
          };
        }
        if (name === KA_SAFETY_CASES_COLLECTION) {
          const cursor = {
            project: () => cursor,
            toArray: async () => opts.cases.filter((c) => c.tenantId === 't1'),
          };
          return { find: () => cursor };
        }
        if (name === KA_FOLLOW_UP_ORPHAN_RECONCILE_REPORTS_COLLECTION) {
          return { insertOne };
        }
        return { insertOne };
      },
    },
  };
}

describe('W2-25 KA follow-up orphan reconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects FU on CLOSED case', async () => {
    const { db } = mockDb({
      followUps: [{
        id: 'fu1',
        tenantId: 't1',
        noDokumen: 'KFU-1',
        safetyCaseId: 'sc1',
        status: 'OPEN',
      }],
      cases: [{
        id: 'sc1',
        tenantId: 't1',
        noDokumen: 'SCF-1',
        status: 'CLOSED',
      }],
    });

    const report = await detectKaFollowUpOrphans(db as never, 't1');
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.summary.activeOnClosed).toBe(1);
    expect(report.mismatches[0]).toMatchObject({
      kind: 'FU_ACTIVE_ON_CLOSED_CASE',
      followUpId: 'fu1',
      safetyCaseId: 'sc1',
      caseStatus: 'CLOSED',
    });
  });

  it('detects FU on missing case', async () => {
    const { db } = mockDb({
      followUps: [{
        id: 'fu2',
        tenantId: 't1',
        noDokumen: 'KFU-2',
        safetyCaseId: 'gone',
        status: 'DONE',
      }],
      cases: [],
    });

    const report = await detectKaFollowUpOrphans(db as never, 't1');
    expect(report.summary.totalMismatch).toBe(1);
    expect(report.summary.activeCaseMissing).toBe(1);
    expect(report.mismatches[0].kind).toBe('FU_ACTIVE_CASE_MISSING');
  });

  it('has no mismatch when case is OPEN or IN_PROGRESS', async () => {
    const { db } = mockDb({
      followUps: [
        {
          id: 'fu3',
          tenantId: 't1',
          noDokumen: 'KFU-3',
          safetyCaseId: 'sc-open',
          status: 'OPEN',
        },
        {
          id: 'fu4',
          tenantId: 't1',
          noDokumen: 'KFU-4',
          safetyCaseId: 'sc-ip',
          status: 'DONE',
        },
      ],
      cases: [
        { id: 'sc-open', tenantId: 't1', noDokumen: 'SCF-O', status: 'OPEN' },
        { id: 'sc-ip', tenantId: 't1', noDokumen: 'SCF-I', status: 'IN_PROGRESS' },
      ],
    });

    const report = await detectKaFollowUpOrphans(db as never, 't1');
    expect(report.summary.totalMismatch).toBe(0);
    expect(report.mismatches).toEqual([]);
  });

  it('repair cancels orphan FU and persists before/after reports', async () => {
    const followUps: FuRow[] = [{
      id: 'fu5',
      tenantId: 't1',
      noDokumen: 'KFU-5',
      safetyCaseId: 'sc-closed',
      status: 'OPEN',
      history: [],
    }];

    const { db, insertOne } = mockDb({
      followUps,
      cases: [{
        id: 'sc-closed',
        tenantId: 't1',
        noDokumen: 'SCF-C',
        status: 'CLOSED',
      }],
    });

    const result = await repairKaFollowUpOrphans(db as never, 't1');

    expect(result.repaired).toBe(1);
    expect(result.skipped).toBe(0);
    expect(followUps[0].status).toBe('CANCELLED');
    expect(followUps[0].history).toEqual([
      expect.objectContaining({
        fromStatus: 'OPEN',
        toStatus: 'CANCELLED',
        note: 'reconcile:orphan-terminal-case',
      }),
    ]);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'KA_FOLLOW_UP_STATUS',
        entityId: 'fu5',
      }),
    );
    expect(insertOne).toHaveBeenCalledTimes(2);
    expect(insertOne.mock.calls[0][0]).toMatchObject({ phase: 'detect-before-repair' });
    expect(insertOne.mock.calls[1][0]).toMatchObject({
      phase: 'detect-after-repair',
      repairActions: expect.any(Array),
      summary: expect.objectContaining({ totalMismatch: 0 }),
    });
    expect(result.afterSummary.totalMismatch).toBe(0);
  });

  it('runKaFollowUpOrphanDetect persists a report', async () => {
    const { db, insertOne } = mockDb({
      followUps: [{
        id: 'fu6',
        tenantId: 't1',
        noDokumen: 'KFU-6',
        status: 'OPEN',
      }],
      cases: [],
    });

    const report = await runKaFollowUpOrphanDetect(db as never, 't1');
    expect(report.summary.activeCaseMissing).toBe(1);
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(insertOne.mock.calls[0][0]).toMatchObject({
      id: 'orphan-uuid-1',
      tenantId: 't1',
    });
  });
});
