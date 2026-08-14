/**
 * Gelombang C — satu follow-up aktif per issue HOLD.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/food-production/document-number', () => ({
  nextKaDocNumber: vi.fn(async () => 'FU-AUTO-1'),
}));

vi.mock('@/lib/kitchen-assurance/document-number', () => ({
  nextKaDocNumber: vi.fn(async () => 'FU-AUTO-1'),
}));

vi.mock('@/lib/api/audit-log', () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

import { ensureOpenFollowUpForCase } from '@/lib/kitchen-assurance/auto-follow-up';

describe('ensureOpenFollowUpForCase', () => {
  let fus: Array<Record<string, unknown>>;
  let caseDoc: Record<string, unknown>;

  function fakeDb() {
    return {
      collection: (name: string) => ({
        findOne: async () => {
          if (name === 'ka_follow_ups') return fus[0] || null;
          return caseDoc;
        },
        insertOne: async (doc: Record<string, unknown>) => {
          fus.push(doc);
          return { insertedId: doc.id };
        },
        updateOne: async (_f: unknown, update: { $set?: Record<string, unknown> }) => {
          Object.assign(caseDoc, update.$set || {});
          return { modifiedCount: 1 };
        },
      }),
    };
  }

  beforeEach(() => {
    fus = [];
    caseDoc = {
      id: 'case-1',
      noDokumen: 'KA-001',
      title: 'HACCP hold',
      category: 'FOOD',
      status: 'OPEN',
      history: [],
    };
  });

  it('membuat FU OPEN jika belum ada', async () => {
    const r = await ensureOpenFollowUpForCase(fakeDb() as never, {
      tenantId: 't1',
      safetyCase: caseDoc as never,
      actor: { userId: 'u1', userName: 'Ops' },
    });
    expect(r.created).toBe(true);
    expect(r.followUp.status).toBe('OPEN');
    expect(fus).toHaveLength(1);
    expect(caseDoc.status).toBe('IN_PROGRESS');
  });

  it('idempoten bila FU aktif sudah ada', async () => {
    fus.push({ id: 'fu-old', noDokumen: 'FU-9', status: 'OPEN' });
    const r = await ensureOpenFollowUpForCase(fakeDb() as never, {
      tenantId: 't1',
      safetyCase: caseDoc as never,
    });
    expect(r.created).toBe(false);
    expect(r.skipped).toBe('active_fu_exists');
    expect(r.followUp.id).toBe('fu-old');
    expect(fus).toHaveLength(1);
  });
});
