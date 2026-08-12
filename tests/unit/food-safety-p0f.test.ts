import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildQcHoldReason,
  hasQcHoldCandidate,
  listQcHoldFailLabels,
  normalizeQcResultItems,
  type QcResultItem,
  type QcTemplateItem,
} from '@/lib/food-production/qc';
import {
  applyQcFoodSafetyOnSave,
  resolveProposedHoldBatchIds,
} from '@/lib/food-production/qc-batch-hold';
import { effectiveFoodSafetyStatus } from '@/lib/food-production/production-batch';

vi.mock('@/lib/kitchen-assurance/auto-issue', () => ({
  ensureOpenKaIssue: vi.fn(async (_db, input) => ({
    created: true,
    case: {
      id: 'ka-qc-1',
      noDokumen: 'KA-QC01',
      tenantId: input.tenantId,
      sourceKey: input.sourceKey,
      batchId: input.batchId,
      proposedHoldBatchIds: input.proposedHoldBatchIds,
    },
  })),
}));

vi.mock('@/lib/api/audit-log', () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

import { ensureOpenKaIssue } from '@/lib/kitchen-assurance/auto-issue';
import { writeAuditLog } from '@/lib/api/audit-log';

const HOLD_TPL: QcTemplateItem[] = [
  { key: 'suhu', label: 'Suhu inti OK', required: true, critical: true, holdOnFail: true },
  { key: 'label', label: 'Label rapi', required: false, critical: false, holdOnFail: false },
  { key: 'termo', label: 'Termometer kalibrasi', required: false, critical: true, holdOnFail: false },
];

function items(raw: Array<{ key: string; result: string }>): QcResultItem[] {
  const out = normalizeQcResultItems(raw, HOLD_TPL);
  if ('error' in (out as object)) throw new Error((out as { error: string }).error);
  return out as QcResultItem[];
}

describe('ADR-004 P0F — deteksi holdOnFail+FAIL', () => {
  it('hanya holdOnFail+FAIL yang kandidat HOLD', () => {
    const mixed = items([
      { key: 'suhu', result: 'FAIL' },
      { key: 'label', result: 'FAIL' },
      { key: 'termo', result: 'FAIL' },
    ]);
    expect(listQcHoldFailLabels(mixed, HOLD_TPL)).toEqual(['Suhu inti OK']);
    expect(hasQcHoldCandidate(mixed, HOLD_TPL)).toBe(true);
  });

  it('critical FAIL tanpa holdOnFail bukan kandidat', () => {
    const onlyCritical = items([
      { key: 'suhu', result: 'PASS' },
      { key: 'label', result: 'PASS' },
      { key: 'termo', result: 'FAIL' },
    ]);
    expect(hasQcHoldCandidate(onlyCritical, HOLD_TPL)).toBe(false);
  });

  it('buildQcHoldReason menyebut dokumen', () => {
    expect(buildQcHoldReason(['Suhu inti OK'], { noDokumen: 'QCR-1', batchNo: 'B-1' }))
      .toMatch(/QCR-1/);
  });
});

describe('ADR-004 P0F — applyQcFoodSafetyOnSave', () => {
  const failed = items([
    { key: 'suhu', result: 'FAIL' },
    { key: 'label', result: 'PASS' },
    { key: 'termo', result: 'PASS' },
  ]);

  let batchDoc: Record<string, unknown>;
  let proposedBatches: Array<{ id: string }>;
  let updates: Array<Record<string, unknown>>;

  function fakeDb() {
    updates = [];
    return {
      collection: (name: string) => ({
        findOne: async () => {
          if (name === 'production_batches') return batchDoc;
          return null;
        },
        find: (filter: Record<string, unknown>) => ({
          limit: () => ({
            toArray: async () => {
              if (name === 'production_batches' && filter.productionPlanId) {
                return proposedBatches;
              }
              if (name === 'production_batches' && filter.kitchenId) {
                return proposedBatches;
              }
              return [];
            },
          }),
        }),
        updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          updates.push({ filter, update });
          if (name === 'production_batches') {
            batchDoc = { ...batchDoc, ...((update as { $set?: Record<string, unknown> }).$set || {}) };
          }
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
      batchNo: 'B-QC-1',
      kitchenId: 'k1',
      kitchenNama: 'Dapur A',
      productionPlanId: 'plan-1',
      foodSafetyStatus: 'PENDING',
      foodSafetyHistory: [],
    };
    proposedBatches = [{ id: 'batch-a' }, { id: 'batch-b' }];
  });

  it('holdOnFail+FAIL + batch → HOLD + qc-hold sourceKey', async () => {
    const result = await applyQcFoodSafetyOnSave(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      qcResultId: 'qc-1',
      qcNoDokumen: 'QCR-0001',
      items: failed,
      templateItems: HOLD_TPL,
      actor: { userId: 'u1', userName: 'Ops' },
    });

    expect(result.held).toBe(true);
    expect(result.proposed).toBeUndefined();
    expect(result.foodSafetyStatus).toBe('HOLD');
    expect(effectiveFoodSafetyStatus(batchDoc as never)).toBe('HOLD');
    const history = batchDoc.foodSafetyHistory as Array<Record<string, unknown>>;
    expect(history[0]).toMatchObject({
      toStatus: 'HOLD',
      sourceType: 'QC',
      sourceId: 'qc-1',
    });
    expect(ensureOpenKaIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKey: 'qc-hold:qc-1',
        batchId: 'batch-1',
      }),
    );
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'FOOD_SAFETY_HOLD',
        entityId: 'batch-1',
        metadata: expect.objectContaining({ sourceType: 'QC', sourceId: 'qc-1' }),
      }),
    );
  });

  it('holdOnFail+FAIL tanpa batch → proposed hold, tidak auto-HOLD', async () => {
    const result = await applyQcFoodSafetyOnSave(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: '',
      qcResultId: 'qc-2',
      qcNoDokumen: 'QCR-0002',
      items: failed,
      templateItems: HOLD_TPL,
      productionPlanId: 'plan-1',
      kitchenId: 'k1',
      tanggal: '2026-08-12',
    });

    expect(result.held).toBe(false);
    expect(result.proposed).toBe(true);
    expect(result.skipped).toBe('no_batch');
    expect(result.proposedHoldBatchIds).toEqual(['batch-a', 'batch-b']);
    expect(batchDoc.foodSafetyStatus).toBe('PENDING');
    expect(ensureOpenKaIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKey: 'qc-proposed-hold:qc-2',
        proposedHoldBatchIds: ['batch-a', 'batch-b'],
      }),
    );
  });

  it('legacy QC tanpa kandidat — no-op (tetap bisa dibaca)', async () => {
    const allPass = items(HOLD_TPL.map((t) => ({ key: t.key, result: 'PASS' })));
    const result = await applyQcFoodSafetyOnSave(fakeDb() as never, {
      tenantId: 't1',
      qcResultId: 'qc-legacy',
      items: allPass,
      templateItems: HOLD_TPL,
    });
    expect(result).toEqual({ held: false, skipped: 'no_candidate' });
    expect(ensureOpenKaIssue).not.toHaveBeenCalled();
  });

  it('idempoten bila batch sudah HOLD', async () => {
    batchDoc.foodSafetyStatus = 'HOLD';
    batchDoc.foodSafetyHistory = [{ toStatus: 'HOLD', sourceType: 'QC' }];
    const result = await applyQcFoodSafetyOnSave(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      qcResultId: 'qc-1',
      items: failed,
      templateItems: HOLD_TPL,
    });
    expect(result.held).toBe(false);
    expect(result.skipped).toBe('already_hold');
    expect(ensureOpenKaIssue).toHaveBeenCalled();
  });

  it('kegagalan KA tidak membatalkan HOLD', async () => {
    vi.mocked(ensureOpenKaIssue).mockRejectedValueOnce(new Error('ka down'));
    const result = await applyQcFoodSafetyOnSave(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      qcResultId: 'qc-ka',
      items: failed,
      templateItems: HOLD_TPL,
    });
    expect(result.held).toBe(true);
    expect(result.kaIssue?.skipped).toBe('ka_error');
  });
});

describe('ADR-004 P0F — resolveProposedHoldBatchIds', () => {
  it('tanpa plan/kitchen+tanggal → []', async () => {
    const db = {
      collection: () => ({
        find: () => ({ limit: () => ({ toArray: async () => [{ id: 'x' }] }) }),
      }),
    };
    const ids = await resolveProposedHoldBatchIds(db as never, { tenantId: 't1' });
    expect(ids).toEqual([]);
  });
});
