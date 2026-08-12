import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTempHoldReason,
  shouldHoldBatchFromTemp,
} from '@/lib/food-production/temperature-log';
import { applyTempHoldToBatch } from '@/lib/food-production/temp-batch-hold';
import { effectiveFoodSafetyStatus } from '@/lib/food-production/production-batch';

vi.mock('@/lib/kitchen-assurance/auto-issue', () => ({
  ensureOpenKaIssue: vi.fn(async (_db, input) => ({
    created: true,
    case: {
      id: 'ka-temp-1',
      noDokumen: 'KA-T01',
      tenantId: input.tenantId,
      sourceKey: input.sourceKey,
      batchId: input.batchId,
    },
  })),
}));

vi.mock('@/lib/api/audit-log', () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

import { ensureOpenKaIssue } from '@/lib/kitchen-assurance/auto-issue';
import { writeAuditLog } from '@/lib/api/audit-log';

describe('ADR-004 P0E — shouldHoldBatchFromTemp', () => {
  it('COOKING + OUT_OF_RANGE + batch → true', () => {
    expect(shouldHoldBatchFromTemp({
      stage: 'COOKING',
      alertStatus: 'OUT_OF_RANGE',
      productionBatchId: 'b1',
    })).toBe(true);
  });

  it('HOLDING + CRITICAL + batch → true', () => {
    expect(shouldHoldBatchFromTemp({
      stage: 'HOLDING',
      alertStatus: 'CRITICAL',
      productionBatchId: 'b1',
    })).toBe(true);
  });

  it('RECEIVING tidak menahan batch meski CRITICAL', () => {
    expect(shouldHoldBatchFromTemp({
      stage: 'RECEIVING',
      alertStatus: 'CRITICAL',
      productionBatchId: 'b1',
    })).toBe(false);
  });

  it('WARN tidak menahan', () => {
    expect(shouldHoldBatchFromTemp({
      stage: 'COOKING',
      alertStatus: 'WARN',
      productionBatchId: 'b1',
    })).toBe(false);
  });

  it('tanpa productionBatchId → false', () => {
    expect(shouldHoldBatchFromTemp({
      stage: 'COOKING',
      alertStatus: 'CRITICAL',
      productionBatchId: '',
    })).toBe(false);
  });

  it('buildTempHoldReason menyebut stage dan suhu', () => {
    const reason = buildTempHoldReason({
      stage: 'COOKING',
      alertStatus: 'CRITICAL',
      suhuC: 50,
      minC: 74,
      maxC: 121,
      batchNo: 'B-1',
    });
    expect(reason).toMatch(/50/);
    expect(reason).toMatch(/CRITICAL/);
    expect(reason).toMatch(/B-1/);
  });
});

describe('ADR-004 P0E — applyTempHoldToBatch', () => {
  let batchDoc: Record<string, unknown>;
  let updates: Array<Record<string, unknown>>;

  function fakeDb() {
    updates = [];
    return {
      collection: (name: string) => ({
        findOne: async () => (name === 'production_batches' ? batchDoc : null),
        updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          if (name === 'production_batches') {
            updates.push({ filter, update });
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
      batchNo: 'B-COOK-9',
      kitchenId: 'k1',
      kitchenNama: 'Dapur A',
      productionPlanId: 'plan-1',
      foodSafetyStatus: 'PENDING',
      foodSafetyHistory: [],
    };
  });

  it('COOKING CRITICAL → HOLD + safety case batch', async () => {
    const result = await applyTempHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      temperatureLogId: 'log-1',
      stage: 'COOKING',
      alertStatus: 'CRITICAL',
      suhuC: 50,
      thresholdMinC: 74,
      thresholdMaxC: 121,
      actor: { userId: 'u1', userName: 'Ops' },
    });

    expect(result.held).toBe(true);
    expect(result.foodSafetyStatus).toBe('HOLD');
    expect(effectiveFoodSafetyStatus(batchDoc as never)).toBe('HOLD');
    const history = batchDoc.foodSafetyHistory as Array<Record<string, unknown>>;
    expect(history[0]).toMatchObject({
      fromStatus: 'PENDING',
      toStatus: 'HOLD',
      sourceType: 'TEMPERATURE',
      sourceId: 'log-1',
    });
    expect(ensureOpenKaIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKey: 'temp-hold:log-1',
        batchId: 'batch-1',
        planId: 'plan-1',
      }),
    );
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'FOOD_SAFETY_HOLD',
        entityId: 'batch-1',
        metadata: expect.objectContaining({ sourceType: 'TEMPERATURE', sourceId: 'log-1' }),
      }),
    );
  });

  it('HOLDING + OUT_OF_RANGE → HOLD', async () => {
    const result = await applyTempHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      temperatureLogId: 'log-holding',
      stage: 'HOLDING',
      alertStatus: 'OUT_OF_RANGE',
      suhuC: 40,
      thresholdMinC: 60,
      thresholdMaxC: 95,
    });
    expect(result.held).toBe(true);
    expect(result.foodSafetyStatus).toBe('HOLD');
    expect(ensureOpenKaIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceKey: 'temp-hold:log-holding' }),
    );
  });

  it('PASS → HOLD dari suhu kritis', async () => {
    batchDoc.foodSafetyStatus = 'PASS';
    const result = await applyTempHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      temperatureLogId: 'log-pass',
      stage: 'COOKING',
      alertStatus: 'CRITICAL',
      suhuC: 45,
      thresholdMinC: 74,
      thresholdMaxC: 121,
    });
    expect(result.held).toBe(true);
    expect(result.foodSafetyStatus).toBe('HOLD');
  });

  it('kegagalan KA tidak membatalkan HOLD', async () => {
    vi.mocked(ensureOpenKaIssue).mockRejectedValueOnce(new Error('ka down'));
    const result = await applyTempHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      temperatureLogId: 'log-ka',
      stage: 'COOKING',
      alertStatus: 'CRITICAL',
      suhuC: 40,
      thresholdMinC: 74,
      thresholdMaxC: 121,
    });
    expect(result.held).toBe(true);
    expect(result.kaIssue?.skipped).toBe('ka_error');
  });

  it('idempoten bila sudah HOLD', async () => {
    batchDoc.foodSafetyStatus = 'HOLD';
    batchDoc.foodSafetyHistory = [{ toStatus: 'HOLD', sourceType: 'TEMPERATURE' }];
    const result = await applyTempHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      temperatureLogId: 'log-2',
      stage: 'HOLDING',
      alertStatus: 'OUT_OF_RANGE',
      suhuC: 40,
      thresholdMinC: 60,
      thresholdMaxC: 95,
    });
    expect(result.held).toBe(false);
    expect(result.skipped).toBe('already_hold');
    expect(updates).toHaveLength(0);
    expect(ensureOpenKaIssue).toHaveBeenCalled();
  });

  it('RECEIVING tidak memanggil HOLD meski lewat apply (guard)', async () => {
    const result = await applyTempHoldToBatch(fakeDb() as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      temperatureLogId: 'log-3',
      stage: 'RECEIVING',
      alertStatus: 'CRITICAL',
      suhuC: 20,
      thresholdMinC: -2,
      thresholdMaxC: 5,
    });
    expect(result).toEqual({ held: false, skipped: 'no_candidate' });
    expect(ensureOpenKaIssue).not.toHaveBeenCalled();
  });
});
