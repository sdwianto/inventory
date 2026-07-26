import { beforeEach, describe, expect, it, vi } from 'vitest';

let uuidSeq = 0;
vi.mock('uuid', () => ({
  v4: vi.fn(() => {
    uuidSeq += 1;
    return `stamp-uuid-${uuidSeq}`;
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
    return `KFU-STAMP-${docSeq}`;
  }),
}));

import { buildKaResolutionFollowUpStamp } from '@/lib/kitchen-assurance/safety-case';
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
  resolution?: { type?: string; followUpId?: string; followUpNo?: string };
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

function applyDottedSet(row: CaseRow, set: Record<string, unknown>) {
  for (const [key, value] of Object.entries(set)) {
    if (key.startsWith('resolution.')) {
      const field = key.slice('resolution.'.length);
      row.resolution = { ...(row.resolution || {}), [field]: value };
      continue;
    }
    (row as Record<string, unknown>)[key] = value;
  }
}

function mockDb(opts: { cases: CaseRow[]; followUps: FuRow[] }) {
  const reportInsertOne = vi.fn(async () => ({ insertedId: 'x' }));
  const fuInsertOne = vi.fn(async (doc: FuRow) => {
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
    applyDottedSet(row, (update.$set || {}) as Record<string, unknown>);
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

describe('W2-29 KA resolution follow-up pointer stamp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidSeq = 0;
    docSeq = 0;
  });

  it('buildKaResolutionFollowUpStamp returns dotted keys only', () => {
    expect(buildKaResolutionFollowUpStamp({ id: 'fu-1', noDokumen: 'KFU-1' })).toEqual({
      'resolution.followUpId': 'fu-1',
      'resolution.followUpNo': 'KFU-1',
    });
    expect(buildKaResolutionFollowUpStamp({ id: 'fu-2' })).toEqual({
      'resolution.followUpId': 'fu-2',
      'resolution.followUpNo': undefined,
    });
    const stamp = buildKaResolutionFollowUpStamp({ id: 'fu-3', noDokumen: 'KFU-3' });
    expect(stamp).not.toHaveProperty('resolution');
    expect(stamp).not.toHaveProperty('resolution.type');
  });

  it('stub insert path stamps followUpId/No on OPEN→IN_PROGRESS $set', async () => {
    const cases: CaseRow[] = [{
      id: 'sc1',
      tenantId: 't1',
      noDokumen: 'SCF-1',
      title: 'Suhu',
      status: 'OPEN',
      resolution: { type: 'FOLLOW_UP' },
      history: [],
    }];
    const { db, caseUpdateOne, fuInsertOne } = mockDb({ cases, followUps: [] });

    const result = await repairKaOpenCaseMissingFu(db as never, 't1');

    expect(result.repaired).toBe(1);
    expect(fuInsertOne).toHaveBeenCalledTimes(1);
    const set = (caseUpdateOne.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
    expect(set.status).toBe('IN_PROGRESS');
    expect(set['resolution.followUpId']).toBe('stamp-uuid-2');
    expect(set['resolution.followUpNo']).toBe('KFU-STAMP-1');
    expect(set).not.toHaveProperty('resolution');
    expect(set).not.toHaveProperty('resolution.type');
    expect(cases[0].resolution).toMatchObject({
      type: 'FOLLOW_UP',
      followUpId: 'stamp-uuid-2',
      followUpNo: 'KFU-STAMP-1',
    });
  });

  it('stub insert on IN_PROGRESS stamps without status bump', async () => {
    const cases: CaseRow[] = [{
      id: 'sc2',
      tenantId: 't1',
      noDokumen: 'SCF-2',
      title: 'Sanitasi',
      status: 'IN_PROGRESS',
      resolution: { type: 'FOLLOW_UP' },
      history: [],
    }];
    const { db, caseUpdateOne } = mockDb({ cases, followUps: [] });

    await repairKaOpenCaseMissingFu(db as never, 't1');

    expect(caseUpdateOne).toHaveBeenCalledTimes(1);
    const set = (caseUpdateOne.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
    expect(set).not.toHaveProperty('status');
    expect(set['resolution.followUpId']).toBeTruthy();
    expect(set['resolution.followUpNo']).toBe('KFU-STAMP-1');
    expect(cases[0].status).toBe('IN_PROGRESS');
    expect(cases[0].resolution?.type).toBe('FOLLOW_UP');
  });

  it('active FU + missing pointer → STAMP_FOLLOW_UP_POINTER (no insert)', async () => {
    const cases: CaseRow[] = [{
      id: 'sc3',
      tenantId: 't1',
      noDokumen: 'SCF-3',
      title: 'Race',
      status: 'OPEN',
      resolution: { type: 'FOLLOW_UP' },
      history: [],
    }];
    const followUps: FuRow[] = [];
    const { db, fuInsertOne, caseUpdateOne, reportInsertOne } = mockDb({ cases, followUps });

    reportInsertOne.mockImplementationOnce(async (doc: { phase?: string }) => {
      if (doc.phase === 'detect-before-repair') {
        followUps.push({
          id: 'fu-active',
          tenantId: 't1',
          safetyCaseId: 'sc3',
          status: 'OPEN',
          noDokumen: 'KFU-ACTIVE',
        });
      }
      return { insertedId: 'x' };
    });

    const result = await repairKaOpenCaseMissingFu(db as never, 't1');

    expect(result.repaired).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.actions[0]).toMatchObject({
      kind: 'STAMP_FOLLOW_UP_POINTER',
      followUpId: 'fu-active',
      followUpNo: 'KFU-ACTIVE',
    });
    expect(fuInsertOne).not.toHaveBeenCalled();
    const set = (caseUpdateOne.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
    expect(set['resolution.followUpId']).toBe('fu-active');
    expect(set['resolution.followUpNo']).toBe('KFU-ACTIVE');
    expect(set).not.toHaveProperty('resolution.type');
    expect(cases[0].resolution?.type).toBe('FOLLOW_UP');
  });

  it('active FU + stale followUpNo → STAMP_FOLLOW_UP_POINTER', async () => {
    const cases: CaseRow[] = [{
      id: 'sc4',
      tenantId: 't1',
      noDokumen: 'SCF-4',
      title: 'Stale no',
      status: 'IN_PROGRESS',
      resolution: {
        type: 'FOLLOW_UP',
        followUpId: 'fu-ok',
        followUpNo: 'KFU-OLD',
      },
      history: [],
    }];
    const followUps: FuRow[] = [];
    const { db, fuInsertOne, caseUpdateOne, reportInsertOne } = mockDb({ cases, followUps });

    reportInsertOne.mockImplementationOnce(async (doc: { phase?: string }) => {
      if (doc.phase === 'detect-before-repair') {
        followUps.push({
          id: 'fu-ok',
          tenantId: 't1',
          safetyCaseId: 'sc4',
          status: 'OPEN',
          noDokumen: 'KFU-NEW',
        });
      }
      return { insertedId: 'x' };
    });

    const result = await repairKaOpenCaseMissingFu(db as never, 't1');

    expect(result.actions[0]?.kind).toBe('STAMP_FOLLOW_UP_POINTER');
    expect(fuInsertOne).not.toHaveBeenCalled();
    expect(caseUpdateOne).toHaveBeenCalled();
    expect(cases[0].resolution).toMatchObject({
      type: 'FOLLOW_UP',
      followUpId: 'fu-ok',
      followUpNo: 'KFU-NEW',
    });
  });

  it('active FU + pointer already correct → SKIP_PRECONDITION (no stamp)', async () => {
    const cases: CaseRow[] = [{
      id: 'sc5',
      tenantId: 't1',
      noDokumen: 'SCF-5',
      title: 'Ok pointer',
      status: 'OPEN',
      resolution: {
        type: 'FOLLOW_UP',
        followUpId: 'fu-ok',
        followUpNo: 'KFU-OK',
      },
      history: [],
    }];
    const followUps: FuRow[] = [];
    const { db, fuInsertOne, caseUpdateOne, reportInsertOne } = mockDb({ cases, followUps });

    reportInsertOne.mockImplementationOnce(async (doc: { phase?: string }) => {
      if (doc.phase === 'detect-before-repair') {
        followUps.push({
          id: 'fu-ok',
          tenantId: 't1',
          safetyCaseId: 'sc5',
          status: 'OPEN',
          noDokumen: 'KFU-OK',
        });
      }
      return { insertedId: 'x' };
    });

    const result = await repairKaOpenCaseMissingFu(db as never, 't1');

    expect(result.repaired).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.actions[0]).toMatchObject({ kind: 'SKIP_PRECONDITION' });
    expect(fuInsertOne).not.toHaveBeenCalled();
    expect(caseUpdateOne).not.toHaveBeenCalled();
  });
});
