import { beforeEach, describe, expect, it, vi } from 'vitest';

let uuidSeq = 0;
vi.mock('uuid', () => ({
  v4: vi.fn(() => {
    uuidSeq += 1;
    return `missing-fu-uuid-${uuidSeq}`;
  }),
}));

const writeAuditLog = vi.fn(async () => undefined);
vi.mock('@/lib/api/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

let docSeq = 0;
vi.mock('@/lib/kitchen-assurance/document-number', () => ({
  nextKaDocNumber: vi.fn(async () => {
    docSeq += 1;
    return `KFU-STUB-${docSeq}`;
  }),
}));

import { KA_FOLLOW_UPS_COLLECTION } from '@/lib/kitchen-assurance/follow-up';
import { KA_SAFETY_CASES_COLLECTION } from '@/lib/kitchen-assurance/safety-case';
import {
  KA_OPEN_CASE_MISSING_FU_RECONCILE_REPORTS_COLLECTION,
  repairKaOpenCaseMissingFu,
} from '@/lib/api/ka-open-case-missing-fu-reconcile';

type CaseRow = {
  id: string;
  tenantId: string;
  noDokumen: string;
  title: string;
  status: string;
  resolution?: { type?: string; followUpId?: string };
  history?: unknown[];
  category?: string;
  kitchenId?: string;
  kitchenNama?: string;
  updatedAt?: Date;
};

type FuRow = {
  id: string;
  tenantId: string;
  safetyCaseId?: string;
  status: string;
  noDokumen?: string;
};

function mockDb(opts: {
  cases: CaseRow[];
  followUps: FuRow[];
  insertFuThrows?: { code: number };
}) {
  const reportInsertOne = vi.fn(async () => ({ insertedId: 'x' }));
  const fuInsertOne = vi.fn(async (doc: FuRow) => {
    if (opts.insertFuThrows) {
      const err = new Error('dup') as Error & { code: number };
      err.code = opts.insertFuThrows.code;
      throw err;
    }
    opts.followUps.push({
      id: doc.id,
      tenantId: doc.tenantId,
      safetyCaseId: doc.safetyCaseId,
      status: doc.status,
      noDokumen: doc.noDokumen,
    });
    return { insertedId: doc.id };
  });

  const caseUpdateOne = vi.fn(async (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => {
    const id = String(filter.id || '');
    const row = opts.cases.find((c) => c.id === id && c.tenantId === filter.tenantId);
    if (!row) return { modifiedCount: 0 };
    if (filter.status && row.status !== filter.status) return { modifiedCount: 0 };
    const set = (update.$set || {}) as Partial<CaseRow>;
    Object.assign(row, set);
    return { modifiedCount: 1 };
  });

  return {
    reportInsertOne,
    fuInsertOne,
    caseUpdateOne,
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
          return {
            find: () => cursor,
            findOne: async (filter: Record<string, unknown>) => {
              const id = String(filter.id || '');
              return opts.cases.find((c) => c.id === id && c.tenantId === filter.tenantId) || null;
            },
            updateOne: caseUpdateOne,
          };
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
            findOne: async (filter: Record<string, unknown>) => {
              const caseId = String(filter.safetyCaseId || '');
              const statusFilter = filter.status;
              return (
                opts.followUps.find((f) => {
                  if (f.tenantId !== filter.tenantId || f.safetyCaseId !== caseId) return false;
                  if (statusFilter && typeof statusFilter === 'object' && '$in' in statusFilter) {
                    const allowed = (statusFilter as { $in: string[] }).$in;
                    return allowed.includes(f.status);
                  }
                  return true;
                }) || null
              );
            },
            insertOne: fuInsertOne,
          };
        }
        if (name === KA_OPEN_CASE_MISSING_FU_RECONCILE_REPORTS_COLLECTION) {
          return { insertOne: reportInsertOne };
        }
        return { insertOne: reportInsertOne };
      },
    },
  };
}

describe('W2-28 KA open-case missing FU soft repair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidSeq = 0;
    docSeq = 0;
  });

  it('ZERO_FU → insertOne called; repaired=1', async () => {
    const cases: CaseRow[] = [{
      id: 'sc1',
      tenantId: 't1',
      noDokumen: 'SCF-1',
      title: 'Suhu chiller',
      status: 'OPEN',
      resolution: { type: 'FOLLOW_UP' },
      history: [],
    }];
    const followUps: FuRow[] = [];
    const { db, fuInsertOne, reportInsertOne, caseUpdateOne } = mockDb({ cases, followUps });

    const result = await repairKaOpenCaseMissingFu(db as never, 't1');

    expect(result.repaired).toBe(1);
    expect(result.skipped).toBe(0);
    expect(fuInsertOne).toHaveBeenCalledTimes(1);
    expect(fuInsertOne.mock.calls[0][0]).toMatchObject({
      safetyCaseId: 'sc1',
      title: 'Follow-up: Suhu chiller',
      status: 'OPEN',
      description: expect.stringContaining('W2-28'),
    });
    expect(cases[0].status).toBe('IN_PROGRESS');
    expect(cases[0].resolution).toEqual({ type: 'FOLLOW_UP' });
    expect(caseUpdateOne).toHaveBeenCalled();
    for (const call of caseUpdateOne.mock.calls) {
      const set = (call[1] as { $set?: Record<string, unknown> }).$set || {};
      expect(set).not.toHaveProperty('resolution');
      expect(JSON.stringify(set)).not.toMatch(/NONE/);
    }
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'KA_FOLLOW_UP_CREATE',
        entityType: 'ka_follow_up',
      }),
    );
    expect(reportInsertOne).toHaveBeenCalledTimes(2);
    expect(reportInsertOne.mock.calls[0][0]).toMatchObject({ phase: 'detect-before-repair' });
    expect(reportInsertOne.mock.calls[1][0]).toMatchObject({
      phase: 'detect-after-repair',
      summary: expect.objectContaining({ totalMismatch: 0 }),
    });
    expect(result.afterSummary.totalMismatch).toBe(0);
  });

  it('ONLY_TERMINAL → insert allowed', async () => {
    const cases: CaseRow[] = [{
      id: 'sc2',
      tenantId: 't1',
      noDokumen: 'SCF-2',
      title: 'Sanitasi',
      status: 'IN_PROGRESS',
      resolution: { type: 'FOLLOW_UP' },
      history: [],
    }];
    const followUps: FuRow[] = [{
      id: 'fu-c',
      tenantId: 't1',
      safetyCaseId: 'sc2',
      status: 'CANCELLED',
      noDokumen: 'KFU-OLD',
    }];
    const { db, fuInsertOne, caseUpdateOne } = mockDb({ cases, followUps });

    const result = await repairKaOpenCaseMissingFu(db as never, 't1');

    expect(result.repaired).toBe(1);
    expect(fuInsertOne).toHaveBeenCalledTimes(1);
    expect(followUps).toHaveLength(2);
    expect(followUps[1]).toMatchObject({
      safetyCaseId: 'sc2',
      status: 'OPEN',
    });
    // IN_PROGRESS case — no status bump
    expect(caseUpdateOne).not.toHaveBeenCalled();
    expect(cases[0].resolution).toEqual({ type: 'FOLLOW_UP' });
  });

  it('active FU appeared → skip', async () => {
    const cases: CaseRow[] = [{
      id: 'sc3',
      tenantId: 't1',
      noDokumen: 'SCF-3',
      title: 'Race',
      status: 'OPEN',
      resolution: { type: 'FOLLOW_UP' },
      history: [],
    }];
    // Detect sees no active FU initially… but we inject OPEN after detect by
    // having findOne return an active row while detect's find still empty.
    // Simpler: start with OPEN FU so detect finds 0 mismatches → repaired=0.
    // For skip path: detect finds mismatch (no active in batch), then findOne
    // returns active — mock by adding FU between detect and findOne via
    // followUps that detect's find excludes? Detect uses $in caseIds; findOne
    // uses safetyCaseId. So put OPEN FU that appears only on findOne:
    // Actually detect finds all FUs for case. If OPEN exists, no mismatch.
    //
    // Race simulation: mutate followUps during first report insert (before repair loop).
    const followUps: FuRow[] = [];
    const { db, fuInsertOne, reportInsertOne } = mockDb({ cases, followUps });

    reportInsertOne.mockImplementationOnce(async (doc: { phase?: string }) => {
      if (doc.phase === 'detect-before-repair') {
        followUps.push({
          id: 'fu-race',
          tenantId: 't1',
          safetyCaseId: 'sc3',
          status: 'OPEN',
          noDokumen: 'KFU-RACE',
        });
      }
      return { insertedId: 'x' };
    });

    const result = await repairKaOpenCaseMissingFu(db as never, 't1');

    expect(result.repaired).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.actions[0]).toMatchObject({ kind: 'SKIP_PRECONDITION' });
    expect(fuInsertOne).not.toHaveBeenCalled();
  });

  it('11000 → SKIP_RACE', async () => {
    const cases: CaseRow[] = [{
      id: 'sc4',
      tenantId: 't1',
      noDokumen: 'SCF-4',
      title: 'Dup',
      status: 'IN_PROGRESS',
      resolution: { type: 'FOLLOW_UP' },
      history: [],
    }];
    const { db, fuInsertOne } = mockDb({
      cases,
      followUps: [],
      insertFuThrows: { code: 11000 },
    });

    const result = await repairKaOpenCaseMissingFu(db as never, 't1');

    expect(result.repaired).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.actions[0]).toMatchObject({ kind: 'SKIP_RACE' });
    expect(fuInsertOne).toHaveBeenCalledTimes(1);
  });

  it('resolution.type not mutated (updateOne never sets/clears resolution)', async () => {
    const cases: CaseRow[] = [{
      id: 'sc5',
      tenantId: 't1',
      noDokumen: 'SCF-5',
      title: 'Keep res',
      status: 'OPEN',
      resolution: { type: 'FOLLOW_UP', followUpId: 'legacy' },
      history: [],
    }];
    const { db, caseUpdateOne } = mockDb({ cases, followUps: [] });

    await repairKaOpenCaseMissingFu(db as never, 't1');

    expect(cases[0].resolution).toEqual({ type: 'FOLLOW_UP', followUpId: 'legacy' });
    for (const call of caseUpdateOne.mock.calls) {
      const update = call[1] as Record<string, unknown>;
      expect(update).not.toHaveProperty('$unset');
      const set = (update.$set || {}) as Record<string, unknown>;
      expect(set).not.toHaveProperty('resolution');
      expect(JSON.stringify(update)).not.toContain('"NONE"');
    }
  });
});
