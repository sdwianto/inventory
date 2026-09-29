import { describe, expect, it } from 'vitest';
import {
  linkOpenResultsToIssue,
  latestCompletedIssueForPlan,
} from '@/lib/api/result-issue-link';
import { assertResultStockGate } from '@/lib/food-production/production-result';

type Row = Record<string, unknown>;

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$and') return (cond as Row[]).every((f) => matches(row, f));
    if (key === '$or') return (cond as Row[]).some((f) => matches(row, f));
    const value = row[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Row;
      if ('$in' in c) return (c.$in as unknown[]).includes(value);
      if ('$exists' in c) return c.$exists ? key in row : !(key in row);
    }
    if (cond === null) return value === null || value === undefined;
    return value === cond;
  });
}

function fakeDb(collections: Record<string, Row[]>) {
  return {
    collection(name: string) {
      const rows = collections[name] || [];
      return {
        async updateMany(filter: Row, update: { $set: Row }) {
          let modifiedCount = 0;
          for (const row of rows) {
            if (!matches(row, filter)) continue;
            Object.assign(row, update.$set);
            modifiedCount += 1;
          }
          return { modifiedCount };
        },
        async findOne(filter: Row, opts?: { sort?: Record<string, number> }) {
          const hits = rows.filter((r) => matches(r, filter));
          if (opts?.sort?.createdAt === -1) {
            hits.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
          }
          return hits[0] ?? null;
        },
      };
    },
  };
}

const tenant = { tenantId: 'sppg' };

describe('linkOpenResultsToIssue', () => {
  it('fills the PBL link on an open HSL created before the PBL was completed', async () => {
    const results: Row[] = [
      { id: 'hsl12', tenantId: 'sppg', productionPlanId: 'rpn13', status: 'APPROVED', materialIssueId: null, materialIssueNo: null },
      { id: 'hsl-done', tenantId: 'sppg', productionPlanId: 'rpn13', status: 'COMPLETED', materialIssueId: null },
      { id: 'hsl-other', tenantId: 'sppg', productionPlanId: 'rpn09', status: 'APPROVED', materialIssueId: null },
      { id: 'hsl-foreign', tenantId: 'lain', productionPlanId: 'rpn13', status: 'APPROVED', materialIssueId: null },
    ];
    const db = fakeDb({ production_results: results });
    const n = await linkOpenResultsToIssue(
      db as never,
      tenant,
      { id: 'pbl14', noDokumen: 'PBL2609000014', productionPlanId: 'rpn13' },
      new Date('2026-09-29T02:00:00Z'),
    );
    expect(n).toBe(1);
    expect(results[0]).toMatchObject({ materialIssueId: 'pbl14', materialIssueNo: 'PBL2609000014' });
    expect(results[1].materialIssueId).toBeNull();
    expect(results[2].materialIssueId).toBeNull();
    expect(results[3].materialIssueId).toBeNull();
  });

  it('keeps an existing link untouched', async () => {
    const results: Row[] = [
      { id: 'hsl', tenantId: 'sppg', productionPlanId: 'rpn', status: 'APPROVED', materialIssueId: 'pbl-old', materialIssueNo: 'PBL-OLD' },
    ];
    const db = fakeDb({ production_results: results });
    const n = await linkOpenResultsToIssue(db as never, tenant, { id: 'pbl-new', noDokumen: 'PBL-NEW', productionPlanId: 'rpn' }, new Date());
    expect(n).toBe(0);
    expect(results[0].materialIssueNo).toBe('PBL-OLD');
  });
});

describe('latestCompletedIssueForPlan', () => {
  it('returns the newest completed PBL of the plan', async () => {
    const db = fakeDb({
      material_issues: [
        { id: 'a', noDokumen: 'PBL-A', tenantId: 'sppg', productionPlanId: 'rpn', status: 'COMPLETED', createdAt: 1 },
        { id: 'b', noDokumen: 'PBL-B', tenantId: 'sppg', productionPlanId: 'rpn', status: 'COMPLETED', createdAt: 2 },
        { id: 'c', noDokumen: 'PBL-C', tenantId: 'sppg', productionPlanId: 'rpn', status: 'DRAFT', createdAt: 3 },
      ],
    });
    const hit = await latestCompletedIssueForPlan(db as never, tenant, 'rpn');
    expect(hit).toEqual({ id: 'b', noDokumen: 'PBL-B' });
  });

  it('returns null when the plan has no completed PBL', async () => {
    const db = fakeDb({ material_issues: [] });
    expect(await latestCompletedIssueForPlan(db as never, tenant, 'rpn09')).toBeNull();
  });
});

describe('assertResultStockGate', () => {
  it('rejects HSL completion when the plan has no completed PBL', () => {
    expect(assertResultStockGate({ hasCompletedIssue: false, hasOpenIssue: false }))
      .toBe('Belum ada pengambilan bahan (PBL) selesai untuk rencana ini');
  });

  it('allows completion once a PBL is completed', () => {
    expect(assertResultStockGate({ hasCompletedIssue: true, hasOpenIssue: false })).toBeNull();
  });
});
