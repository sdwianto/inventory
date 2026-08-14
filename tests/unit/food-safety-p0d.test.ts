import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HACCP_TEMPLATES,
  buildHaccpHoldReason,
  hasHaccpHoldCandidate,
  listHaccpHoldFailLabels,
  normalizeHaccpResultItems,
  type HaccpResultItem,
  type HaccpTemplateItem,
} from '@/lib/food-production/haccp';
import { applyHaccpHoldToBatch } from '@/lib/food-production/haccp-batch-hold';
import { effectiveFoodSafetyStatus } from '@/lib/food-production/production-batch';

vi.mock('@/lib/kitchen-assurance/auto-issue', () => ({
  ensureOpenKaIssue: vi.fn(async (_db, input) => ({
    created: true,
    case: {
      id: 'ka-1',
      noDokumen: 'KA-001',
      tenantId: input.tenantId,
      sourceKey: input.sourceKey,
      batchId: undefined,
    },
  })),
}));

vi.mock('@/lib/kitchen-assurance/auto-follow-up', () => ({
  ensureOpenFollowUpForCase: vi.fn(async (_db, input) => ({
    created: true,
    followUp: {
      id: 'fu-1',
      noDokumen: 'FU-001',
      status: 'OPEN',
    },
    caseId: input.safetyCase?.id,
  })),
}));

vi.mock('@/lib/api/audit-log', () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

import { ensureOpenKaIssue } from '@/lib/kitchen-assurance/auto-issue';
import { writeAuditLog } from '@/lib/api/audit-log';

const COOK_TPL = DEFAULT_HACCP_TEMPLATES[0].items;

function items(raw: Array<{ key: string; result: string }>, tpl = COOK_TPL): HaccpResultItem[] {
  const out = normalizeHaccpResultItems(raw, tpl);
  if ('error' in (out as object)) throw new Error((out as { error: string }).error);
  return out as HaccpResultItem[];
}

describe('ADR-004 P0D — deteksi holdOnFail+FAIL', () => {
  it('list label item holdOnFail yang FAIL', () => {
    const one = items([
      { key: 'core_temp', result: 'FAIL' },
      { key: 'hold_time', result: 'PASS' },
      { key: 'thermometer_cal', result: 'FAIL' },
    ]);
    // thermometer_cal: critical+holdOnFail=false — tidak menahan
    expect(listHaccpHoldFailLabels(one, COOK_TPL, 'CCP_COOK')).toEqual([
      'Suhu inti ≥ 74°C tercapai',
    ]);
    expect(hasHaccpHoldCandidate(one, COOK_TPL, 'CCP_COOK')).toBe(true);
  });

  it('critical FAIL tanpa holdOnFail bukan kandidat HOLD', () => {
    const tpl: HaccpTemplateItem[] = [
      { key: 'a', label: 'A', required: true, critical: true, holdOnFail: true },
      { key: 'b', label: 'B', required: false, critical: true, holdOnFail: false },
    ];
    const onlyCritical = items([{ key: 'a', result: 'PASS' }, { key: 'b', result: 'FAIL' }], tpl);
    expect(hasHaccpHoldCandidate(onlyCritical, tpl)).toBe(false);
  });

  it('buildHaccpHoldReason menyertakan dokumen dan batch', () => {
    expect(buildHaccpHoldReason(['Suhu inti'], { noDokumen: 'HCP-1', batchNo: 'B-1' }))
      .toContain('Suhu inti');
    expect(buildHaccpHoldReason(['Suhu inti'], { noDokumen: 'HCP-1', batchNo: 'B-1' }))
      .toContain('HCP-1');
  });
});

describe('ADR-004 P0D — applyHaccpHoldToBatch', () => {
  const failedItems = items([
    { key: 'core_temp', result: 'FAIL' },
    { key: 'hold_time', result: 'PASS' },
    { key: 'thermometer_cal', result: 'PASS' },
  ]);

  let batchDoc: Record<string, unknown>;
  let updates: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }>;
  let kaUpdates: Array<Record<string, unknown>>;

  function fakeDb() {
    updates = [];
    kaUpdates = [];
    return {
      collection: (name: string) => ({
        findOne: async () => {
          if (name === 'production_batches') return batchDoc;
          return null;
        },
        updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          if (name === 'production_batches') {
            updates.push({ filter, update });
            const set = (update as { $set?: Record<string, unknown> }).$set || {};
            batchDoc = { ...batchDoc, ...set };
          }
          if (name === 'ka_safety_cases') kaUpdates.push({ filter, update });
          return { modifiedCount: 1 };
        },
      }),
    };
  }

  beforeEach(() => {
    vi.mocked(ensureOpenKaIssue).mockClear();
    vi.mocked(writeAuditLog).mockClear();
    batchDoc = {
      id: 'batch-1',
      tenantId: 't1',
      batchNo: 'B-COOK-1',
      kitchenId: 'k1',
      kitchenNama: 'Dapur A',
      productionPlanId: 'plan-1',
      foodSafetyStatus: 'PENDING',
      foodSafetyHistory: [],
    };
  });

  it('PENDING → HOLD saat holdOnFail+FAIL disimpan (DRAFT path)', async () => {
    const result = await applyHaccpHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      haccpResultId: 'hcp-1',
      haccpNoDokumen: 'HCP-0001',
      items: failedItems,
      templateItems: COOK_TPL,
      category: 'CCP_COOK',
      actor: { userId: 'u1', userName: 'Ops' },
    });

    expect(result.held).toBe(true);
    expect(result.foodSafetyStatus).toBe('HOLD');
    expect(result.kaIssue?.id).toBe('ka-1');
    expect(result.kaIssue?.temuanHref).toContain('/kitchen-assurance/temuan');
    expect(result.kaIssue?.temuanHref).toContain('caseId=ka-1');
    expect(result.kaIssue?.temuanHref).toContain('batch=batch-1');
    expect(result.kaIssue?.followUpHref).toContain('/kitchen-assurance/follow-up');
    expect(result.kaIssue?.followUpHref).toContain('upload=1');
    expect(result.kaIssue?.followUpId).toBe('fu-1');
    expect(effectiveFoodSafetyStatus(batchDoc as never)).toBe('HOLD');
    expect(updates).toHaveLength(1);
    const history = batchDoc.foodSafetyHistory as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: 'PENDING',
      toStatus: 'HOLD',
      sourceType: 'HACCP',
      sourceId: 'hcp-1',
    });
    expect(String(history[0].note)).toMatch(/Suhu inti/);
    expect(ensureOpenKaIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKey: 'haccp-hold:hcp-1',
        category: 'FOOD',
        batchId: 'batch-1',
        planId: 'plan-1',
      }),
    );
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'FOOD_SAFETY_HOLD',
        entityType: 'production_batch',
        entityId: 'batch-1',
        metadata: expect.objectContaining({ sourceType: 'HACCP', sourceId: 'hcp-1' }),
      }),
    );
  });

  it('RELEASED → HOLD bila temuan baru (ADR re-hold)', async () => {
    batchDoc.foodSafetyStatus = 'RELEASED';
    const result = await applyHaccpHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      haccpResultId: 'hcp-2',
      items: failedItems,
      templateItems: COOK_TPL,
      category: 'CCP_COOK',
    });
    expect(result.held).toBe(true);
    expect(result.foodSafetyStatus).toBe('HOLD');
  });

  it('PASS → HOLD bila temuan holdOnFail', async () => {
    batchDoc.foodSafetyStatus = 'PASS';
    const result = await applyHaccpHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      haccpResultId: 'hcp-3',
      items: failedItems,
      templateItems: COOK_TPL,
      category: 'CCP_COOK',
    });
    expect(result.held).toBe(true);
    expect(result.foodSafetyStatus).toBe('HOLD');
  });

  it('kegagalan KA tidak membatalkan HOLD batch', async () => {
    vi.mocked(ensureOpenKaIssue).mockRejectedValueOnce(new Error('ka down'));
    const result = await applyHaccpHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      haccpResultId: 'hcp-4',
      items: failedItems,
      templateItems: COOK_TPL,
      category: 'CCP_COOK',
    });
    expect(result.held).toBe(true);
    expect(result.foodSafetyStatus).toBe('HOLD');
    expect(result.kaIssue?.skipped).toBe('ka_error');
  });

  it('idempoten — batch sudah HOLD tidak menambah history ulang', async () => {
    batchDoc.foodSafetyStatus = 'HOLD';
    batchDoc.foodSafetyHistory = [{
      at: new Date('2026-08-01'),
      fromStatus: 'PENDING',
      toStatus: 'HOLD',
      note: 'sebelumnya',
      sourceType: 'HACCP',
    }];

    const result = await applyHaccpHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      haccpResultId: 'hcp-1',
      items: failedItems,
      templateItems: COOK_TPL,
      category: 'CCP_COOK',
    });

    expect(result.held).toBe(false);
    expect(result.skipped).toBe('already_hold');
    expect(updates.filter((u) => u.filter && 'id' in (u.filter as object))).toHaveLength(0);
    // safety case tetap di-ensure
    expect(ensureOpenKaIssue).toHaveBeenCalled();
    expect((batchDoc.foodSafetyHistory as unknown[]).length).toBe(1);
  });

  it('tanpa kandidat HOLD — no-op', async () => {
    const allPass = items(COOK_TPL.map((t) => ({ key: t.key, result: 'PASS' })));
    const result = await applyHaccpHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      haccpResultId: 'hcp-1',
      items: allPass,
      templateItems: COOK_TPL,
      category: 'CCP_COOK',
    });
    expect(result).toEqual({ held: false, skipped: 'no_candidate' });
    expect(ensureOpenKaIssue).not.toHaveBeenCalled();
  });

  it('batch hilang — tidak melempar, HACCP save tetap aman', async () => {
    const db = {
      collection: () => ({
        findOne: async () => null,
        updateOne: async () => ({ modifiedCount: 0 }),
      }),
    };
    const result = await applyHaccpHoldToBatch(db as never, {
      tenantId: 't1',
      productionBatchId: 'missing',
      haccpResultId: 'hcp-1',
      items: failedItems,
      templateItems: COOK_TPL,
      category: 'CCP_COOK',
    });
    expect(result.held).toBe(false);
    expect(result.skipped).toBe('batch_missing');
  });

  it('ensureOpenKaIssue idempoten pada save ulang', async () => {
    vi.mocked(ensureOpenKaIssue)
      .mockResolvedValueOnce({
        created: true,
        case: {
          id: 'ka-1',
          noDokumen: 'KA-001',
          tenantId: 't1',
          sourceKey: 'haccp-hold:hcp-1',
          batchId: 'batch-1',
        } as never,
      })
      .mockResolvedValueOnce({
        created: false,
        skipped: 'open_issue_exists',
        case: {
          id: 'ka-1',
          noDokumen: 'KA-001',
          tenantId: 't1',
          sourceKey: 'haccp-hold:hcp-1',
          batchId: 'batch-1',
        } as never,
      });

    const first = await applyHaccpHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      haccpResultId: 'hcp-1',
      items: failedItems,
      templateItems: COOK_TPL,
      category: 'CCP_COOK',
    });
    expect(first.held).toBe(true);
    expect(first.kaIssue?.created).toBe(true);

    const second = await applyHaccpHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      haccpResultId: 'hcp-1',
      items: failedItems,
      templateItems: COOK_TPL,
      category: 'CCP_COOK',
    });
    expect(second.held).toBe(false);
    expect(second.skipped).toBe('already_hold');
    expect(second.kaIssue?.skipped).toBe('open_issue_exists');
  });
});

describe('ADR-004 P0D — prasyarat FEFO (P0A-2) masih aktif', () => {
  it('consumeBatchesFefo menolak HOLD saat enforcement on', async () => {
    const { consumeBatchesFefo } = await import('@/lib/food-production/fefo-consume');
    const seen: Array<Record<string, unknown>> = [];
    const cursor = { sort: () => cursor, toArray: async () => [] };
    const db = {
      collection: () => ({
        find: (filter: Record<string, unknown>) => {
          seen.push(filter);
          return cursor;
        },
      }),
    };
    await consumeBatchesFefo(db as never, {
      tenantId: 't1',
      stokId: 'fg1',
      warehouseKode: 'GKERING',
      needQty: 1,
      enforceFoodSafetyHold: true,
    });
    expect(seen[0].foodSafetyStatus).toEqual({ $ne: 'HOLD' });
  });
});
