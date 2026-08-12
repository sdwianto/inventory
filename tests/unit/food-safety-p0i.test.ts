/**
 * ADR-004 P0I — Regression / Definition of Done.
 * Detect → Hold → Prevent Distribution → Correct → Verify → Release → Allow
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HACCP_TEMPLATES,
  normalizeHaccpResultItems,
  type HaccpResultItem,
} from '@/lib/food-production/haccp';
import { applyHaccpHoldToBatch } from '@/lib/food-production/haccp-batch-hold';
import { applyTempHoldToBatch } from '@/lib/food-production/temp-batch-hold';
import {
  applyQcFoodSafetyOnSave,
} from '@/lib/food-production/qc-batch-hold';
import {
  normalizeQcResultItems,
  type QcResultItem,
  type QcTemplateItem,
} from '@/lib/food-production/qc';
import {
  effectiveFoodSafetyStatus,
  isFoodSafetyBlocked,
} from '@/lib/food-production/production-batch';
import { allocateFefo } from '@/lib/food-production/fefo-allocate';
import {
  assertFefoExitNotBlockedByHold,
  checkFefoExitLineAgainstHold,
} from '@/lib/food-production/food-safety-exit-gate';
import { releaseBatchFromVerifiedFollowUp } from '@/lib/food-production/food-safety-release';
import { assertFollowUpCanVerify } from '@/lib/kitchen-assurance/follow-up';

vi.mock('@/lib/kitchen-assurance/auto-issue', () => ({
  ensureOpenKaIssue: vi.fn(async (_db, input) => ({
    created: true,
    case: {
      id: `ka-${input.sourceKey}`,
      noDokumen: 'KA-P0I',
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

const COOK_TPL = DEFAULT_HACCP_TEMPLATES[0].items;

const QC_TPL: QcTemplateItem[] = [
  { key: 'suhu', label: 'Suhu inti OK', required: true, critical: true, holdOnFail: true },
  { key: 'label', label: 'Label rapi', required: false, critical: false, holdOnFail: false },
];

function haccpFailItems(): HaccpResultItem[] {
  const out = normalizeHaccpResultItems(
    COOK_TPL.map((t) => ({
      key: t.key,
      result: t.holdOnFail ? 'FAIL' : 'PASS',
    })),
    COOK_TPL,
  );
  if ('error' in (out as object)) throw new Error((out as { error: string }).error);
  return out as HaccpResultItem[];
}

function qcFailItems(): QcResultItem[] {
  const out = normalizeQcResultItems(
    [
      { key: 'suhu', result: 'FAIL' },
      { key: 'label', result: 'PASS' },
    ],
    QC_TPL,
  );
  if ('error' in (out as object)) throw new Error((out as { error: string }).error);
  return out as QcResultItem[];
}

type BatchDoc = Record<string, unknown>;

function makeBatchStore(initial: BatchDoc[]) {
  const byId = new Map(initial.map((b) => [String(b.id), { ...b }]));
  const kaCalls: Array<Record<string, unknown>> = [];

  const db = {
    collection: (name: string) => ({
      findOne: async (filter: Record<string, unknown>) => {
        if (name === 'production_batches') {
          const id = String(filter.id || '');
          return byId.get(id) || null;
        }
        return null;
      },
      find: (filter: Record<string, unknown>) => {
        const rows = [...byId.values()].filter((b) => {
          if (filter.finishedGoodProductId && b.finishedGoodProductId !== filter.finishedGoodProductId) {
            return false;
          }
          if (filter.warehouseKode && b.warehouseKode !== filter.warehouseKode) return false;
          if (filter.productionResultId && b.productionResultId !== filter.productionResultId) {
            return false;
          }
          if (filter.productionPlanId && b.productionPlanId !== filter.productionPlanId) return false;
          if (filter.kitchenId && b.kitchenId !== filter.kitchenId) return false;
          if (filter.status && Array.isArray((filter.status as { $in?: string[] }).$in)) {
            const allowed = (filter.status as { $in: string[] }).$in;
            if (!allowed.includes(String(b.status))) return false;
          }
          return true;
        });
        const cursor = {
          sort: () => cursor,
          limit: () => ({ toArray: async () => rows }),
          toArray: async () => rows,
        };
        return cursor;
      },
      updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        if (name === 'production_batches') {
          const id = String(filter.id || '');
          const cur = byId.get(id);
          if (!cur) return { modifiedCount: 0 };
          const set = (update as { $set?: Record<string, unknown> }).$set || {};
          byId.set(id, { ...cur, ...set });
          return { modifiedCount: 1 };
        }
        kaCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    }),
  };

  return {
    db,
    get: (id: string) => byId.get(id),
    kaCalls,
  };
}

describe('ADR-004 P0I — regression DoD (35–44)', () => {
  beforeEach(() => {
    vi.mocked(ensureOpenKaIssue).mockClear();
    vi.mocked(ensureOpenKaIssue).mockImplementation(async (_db, input) => ({
      created: true,
      case: {
        id: `ka-${input.sourceKey}`,
        noDokumen: 'KA-P0I',
        tenantId: input.tenantId,
        sourceKey: input.sourceKey,
        batchId: input.batchId,
        proposedHoldBatchIds: input.proposedHoldBatchIds,
      },
    }));
  });

  it('35 — CCP FAIL saat DRAFT → HOLD (tidak menunggu COMPLETED)', async () => {
    const store = makeBatchStore([{
      id: 'batch-a',
      tenantId: 't1',
      batchNo: 'B-A',
      kitchenId: 'k1',
      productionPlanId: 'plan-1',
      foodSafetyStatus: 'PENDING',
      foodSafetyHistory: [],
      status: 'ACTIVE',
      qtyRemaining: 10,
    }]);

    // applyHaccpHoldToBatch dipanggil dari save path termasuk DRAFT — tidak cek status dokumen.
    const result = await applyHaccpHoldToBatch(store.db as never, {
      tenantId: 't1',
      productionBatchId: 'batch-a',
      haccpResultId: 'hcp-draft-1',
      haccpNoDokumen: 'HCP-DRAFT',
      items: haccpFailItems(),
      templateItems: COOK_TPL,
      category: 'CCP_COOK',
      actor: { userId: 'u1', userName: 'Ops' },
    });

    expect(result.held).toBe(true);
    expect(effectiveFoodSafetyStatus(store.get('batch-a') as never)).toBe('HOLD');
    expect(isFoodSafetyBlocked(store.get('batch-a') as never)).toBe(true);
  });

  it('36–37 — CCP FAIL → FEFO block + distribution exit gate block', async () => {
    const store = makeBatchStore([{
      id: 'batch-hold',
      tenantId: 't1',
      batchNo: 'B-HOLD',
      finishedGoodProductId: 'fg1',
      warehouseKode: 'WH1',
      status: 'ACTIVE',
      expiryDate: '2026-08-20',
      qtyRemaining: 10,
      foodSafetyStatus: 'HOLD',
    }]);

    const alloc = allocateFefo(
      5,
      [{
        id: 'batch-hold',
        batchNo: 'B-HOLD',
        expiryDate: '2026-08-20',
        qtyRemaining: 10,
        foodSafetyStatus: 'HOLD',
      }],
      { asOf: new Date('2026-08-12'), rejectFoodSafetyHold: true },
    );
    expect(alloc.allocated).toBe(0);
    expect(alloc.shortfall).toBe(5);

    const lineCheck = await checkFefoExitLineAgainstHold(store.db as never, {
      tenantId: 't1',
      line: {
        stokId: 'fg1',
        stokNama: 'Nasi',
        warehouseKode: 'WH1',
        needQty: 5,
      },
      asOf: new Date('2026-08-12'),
    });
    expect(lineCheck.ok).toBe(false);
    if (!lineCheck.ok) expect(lineCheck.error).toMatch(/HOLD/);

    const distGate = await assertFefoExitNotBlockedByHold(store.db as never, {
      tenantId: 't1',
      enforce: true,
      context: 'distribusi',
      lines: [{ stokId: 'fg1', warehouseKode: 'WH1', needQty: 5 }],
      asOf: new Date('2026-08-12'),
    });
    expect(distGate.ok).toBe(false);
  });

  it('38 — Isolation: batch lain dari production result sama tetap PENDING', async () => {
    const store = makeBatchStore([
      {
        id: 'batch-fail',
        tenantId: 't1',
        batchNo: 'B-FAIL',
        productionResultId: 'pr-1',
        productionPlanId: 'plan-1',
        kitchenId: 'k1',
        foodSafetyStatus: 'PENDING',
        foodSafetyHistory: [],
        status: 'ACTIVE',
      },
      {
        id: 'batch-ok',
        tenantId: 't1',
        batchNo: 'B-OK',
        productionResultId: 'pr-1',
        productionPlanId: 'plan-1',
        kitchenId: 'k1',
        foodSafetyStatus: 'PENDING',
        foodSafetyHistory: [],
        status: 'ACTIVE',
      },
    ]);

    await applyHaccpHoldToBatch(store.db as never, {
      tenantId: 't1',
      productionBatchId: 'batch-fail',
      haccpResultId: 'hcp-iso',
      items: haccpFailItems(),
      templateItems: COOK_TPL,
      category: 'CCP_COOK',
    });

    expect(effectiveFoodSafetyStatus(store.get('batch-fail') as never)).toBe('HOLD');
    expect(effectiveFoodSafetyStatus(store.get('batch-ok') as never)).toBe('PENDING');
    expect(store.get('batch-ok')?.status).toBe('ACTIVE');
  });

  it('39 — temperature critical → HOLD', async () => {
    const store = makeBatchStore([{
      id: 'batch-temp',
      tenantId: 't1',
      batchNo: 'B-TEMP',
      kitchenId: 'k1',
      foodSafetyStatus: 'PENDING',
      foodSafetyHistory: [],
    }]);

    const result = await applyTempHoldToBatch(store.db as never, {
      tenantId: 't1',
      productionBatchId: 'batch-temp',
      temperatureLogId: 'tlog-1',
      stage: 'COOKING',
      alertStatus: 'CRITICAL',
      suhuC: 50,
      thresholdMinC: 74,
      thresholdMaxC: 121,
    });

    expect(result.held).toBe(true);
    expect(effectiveFoodSafetyStatus(store.get('batch-temp') as never)).toBe('HOLD');
    expect(ensureOpenKaIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceKey: 'temp-hold:tlog-1' }),
    );
  });

  it('40 — QC critical holdOnFail + batch → HOLD', async () => {
    const store = makeBatchStore([{
      id: 'batch-qc',
      tenantId: 't1',
      batchNo: 'B-QC',
      kitchenId: 'k1',
      productionPlanId: 'plan-1',
      foodSafetyStatus: 'PENDING',
      foodSafetyHistory: [],
    }]);

    const result = await applyQcFoodSafetyOnSave(store.db as never, {
      tenantId: 't1',
      productionBatchId: 'batch-qc',
      qcResultId: 'qc-1',
      items: qcFailItems(),
      templateItems: QC_TPL,
    });

    expect(result.held).toBe(true);
    expect(effectiveFoodSafetyStatus(store.get('batch-qc') as never)).toBe('HOLD');
  });

  it('41 — QC tanpa batch → tidak auto-HOLD (proposed saja)', async () => {
    const store = makeBatchStore([
      { id: 'batch-a', tenantId: 't1', productionPlanId: 'plan-1', kitchenId: 'k1' },
      { id: 'batch-b', tenantId: 't1', productionPlanId: 'plan-1', kitchenId: 'k1' },
    ]);

    const result = await applyQcFoodSafetyOnSave(store.db as never, {
      tenantId: 't1',
      productionBatchId: '',
      qcResultId: 'qc-proposed',
      items: qcFailItems(),
      templateItems: QC_TPL,
      productionPlanId: 'plan-1',
      kitchenId: 'k1',
      tanggal: '2026-08-12',
    });

    expect(result.held).toBe(false);
    expect(result.proposed).toBe(true);
    expect(effectiveFoodSafetyStatus(store.get('batch-a') as never)).toBe('PENDING');
    expect(effectiveFoodSafetyStatus(store.get('batch-b') as never)).toBe('PENDING');
    expect(ensureOpenKaIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceKey: 'qc-proposed-hold:qc-proposed' }),
    );
  });

  it('42 — duplicate event → tidak membuat safety case ganda (sourceKey idempoten)', async () => {
    const store = makeBatchStore([{
      id: 'batch-dup',
      tenantId: 't1',
      batchNo: 'B-DUP',
      kitchenId: 'k1',
      productionPlanId: 'plan-1',
      foodSafetyStatus: 'PENDING',
      foodSafetyHistory: [],
    }]);

    const input = {
      tenantId: 't1',
      productionBatchId: 'batch-dup',
      haccpResultId: 'hcp-dup',
      items: haccpFailItems(),
      templateItems: COOK_TPL,
      category: 'CCP_COOK' as const,
    };

    await applyHaccpHoldToBatch(store.db as never, input);
    expect(ensureOpenKaIssue).toHaveBeenCalledTimes(1);

    vi.mocked(ensureOpenKaIssue).mockImplementationOnce(async (_db, inp) => ({
      created: false,
      skipped: 'already_open',
      case: {
        id: `ka-${inp.sourceKey}`,
        noDokumen: 'KA-P0I',
        tenantId: inp.tenantId,
        sourceKey: inp.sourceKey,
        batchId: inp.batchId,
      },
    }));

    const second = await applyHaccpHoldToBatch(store.db as never, input);
    expect(second.held).toBe(false);
    expect(second.skipped).toBe('already_hold');
    expect(ensureOpenKaIssue).toHaveBeenCalledTimes(2);
    expect(ensureOpenKaIssue).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ sourceKey: 'haccp-hold:hcp-dup' }),
    );
    expect(ensureOpenKaIssue).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ sourceKey: 'haccp-hold:hcp-dup' }),
    );
    expect((store.get('batch-dup')?.foodSafetyHistory as unknown[]).length).toBe(1);
  });

  it('43–44 — VERIFIED → RELEASED → dapat dialokasikan kembali', async () => {
    expect(assertFollowUpCanVerify({ status: 'DONE', evidenceMedia: ['ev'] })).toBeNull();

    const store = makeBatchStore([{
      id: 'batch-rel',
      tenantId: 't1',
      batchNo: 'B-REL',
      finishedGoodProductId: 'fg1',
      warehouseKode: 'WH1',
      status: 'ACTIVE',
      expiryDate: '2026-08-20',
      qtyRemaining: 10,
      foodSafetyStatus: 'HOLD',
      foodSafetyHistory: [{
        fromStatus: 'PENDING',
        toStatus: 'HOLD',
        sourceType: 'HACCP',
        sourceId: 'hcp-1',
      }],
    }]);

    const release = await releaseBatchFromVerifiedFollowUp(store.db as never, {
      tenantId: 't1',
      followUp: {
        id: 'fu-1',
        noDokumen: 'FU-001',
        status: 'VERIFIED',
        safetyCaseId: 'case-1',
      },
      safetyCase: { id: 'case-1', batchId: 'batch-rel', noDokumen: 'KA-1' },
      reason: 'Koreksi terverifikasi',
      actor: { userId: 'sup1', userName: 'Supervisor' },
    });

    expect(release.released).toBe(true);
    expect(effectiveFoodSafetyStatus(store.get('batch-rel') as never)).toBe('RELEASED');
    expect(isFoodSafetyBlocked(store.get('batch-rel') as never)).toBe(false);

    const history = store.get('batch-rel')?.foodSafetyHistory as Array<Record<string, unknown>>;
    expect(history.at(-1)).toMatchObject({
      toStatus: 'RELEASED',
      sourceType: 'KA_FOLLOW_UP',
      sourceId: 'fu-1',
    });

    const alloc = allocateFefo(
      5,
      [{
        id: 'batch-rel',
        batchNo: 'B-REL',
        expiryDate: '2026-08-20',
        qtyRemaining: 10,
        foodSafetyStatus: 'RELEASED',
      }],
      { asOf: new Date('2026-08-12'), rejectFoodSafetyHold: true },
    );
    expect(alloc.allocated).toBe(5);
    expect(alloc.shortfall).toBe(0);

    const exit = await assertFefoExitNotBlockedByHold(store.db as never, {
      tenantId: 't1',
      enforce: true,
      context: 'distribusi',
      lines: [{ stokId: 'fg1', warehouseKode: 'WH1', needQty: 5 }],
      asOf: new Date('2026-08-12'),
    });
    expect(exit.ok).toBe(true);
  });

  it('full chain — Detect→Hold→Block→Verify→Release→Allow', async () => {
    const store = makeBatchStore([
      {
        id: 'batch-chain',
        tenantId: 't1',
        batchNo: 'B-CHAIN',
        finishedGoodProductId: 'fg1',
        warehouseKode: 'WH1',
        productionResultId: 'pr-chain',
        kitchenId: 'k1',
        productionPlanId: 'plan-1',
        status: 'ACTIVE',
        expiryDate: '2026-08-20',
        qtyRemaining: 8,
        foodSafetyStatus: 'PENDING',
        foodSafetyHistory: [],
      },
      {
        id: 'batch-sibling',
        tenantId: 't1',
        batchNo: 'B-SIB',
        finishedGoodProductId: 'fg1',
        warehouseKode: 'WH1',
        productionResultId: 'pr-chain',
        kitchenId: 'k1',
        productionPlanId: 'plan-1',
        status: 'ACTIVE',
        expiryDate: '2026-08-21',
        qtyRemaining: 8,
        foodSafetyStatus: 'PENDING',
        foodSafetyHistory: [],
      },
    ]);

    const held = await applyHaccpHoldToBatch(store.db as never, {
      tenantId: 't1',
      productionBatchId: 'batch-chain',
      haccpResultId: 'hcp-chain',
      items: haccpFailItems(),
      templateItems: COOK_TPL,
      category: 'CCP_COOK',
    });
    expect(held.held).toBe(true);

    const blocked = await assertFefoExitNotBlockedByHold(store.db as never, {
      tenantId: 't1',
      enforce: true,
      lines: [{
        stokId: 'fg1',
        warehouseKode: 'WH1',
        needQty: 10,
        productionResultId: 'pr-chain',
      }],
      asOf: new Date('2026-08-12'),
    });
    // sibling PENDING (8) < need 10, hold (8) tertahan → shortfall
    expect(blocked.ok).toBe(false);

    const released = await releaseBatchFromVerifiedFollowUp(store.db as never, {
      tenantId: 't1',
      followUp: {
        id: 'fu-chain',
        noDokumen: 'FU-CHAIN',
        status: 'VERIFIED',
        safetyCaseId: 'case-chain',
      },
      safetyCase: { id: 'case-chain', batchId: 'batch-chain' },
      reason: 'OK',
    });
    expect(released.released).toBe(true);
    expect(effectiveFoodSafetyStatus(store.get('batch-sibling') as never)).toBe('PENDING');

    const allowed = await assertFefoExitNotBlockedByHold(store.db as never, {
      tenantId: 't1',
      enforce: true,
      lines: [{
        stokId: 'fg1',
        warehouseKode: 'WH1',
        needQty: 10,
        productionResultId: 'pr-chain',
      }],
      asOf: new Date('2026-08-12'),
    });
    expect(allowed.ok).toBe(true);
  });
});
