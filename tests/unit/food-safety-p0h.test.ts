import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyFoodSafetyTransition } from '@/lib/food-production/production-batch';
import { releaseBatchFromVerifiedFollowUp } from '@/lib/food-production/food-safety-release';
import { FP_MANAGE_ROLES, FP_OPS_WRITE_ROLES } from '@/lib/food-production/roles';
import { KA_MANAGE_ROLES } from '@/lib/kitchen-assurance/roles';

vi.mock('@/lib/api/audit-log', () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

import { writeAuditLog } from '@/lib/api/audit-log';

describe('ADR-004 P0H — otoritas RELEASE', () => {
  it('KA_MANAGE = FP_MANAGE — GUDANG tidak termasuk', () => {
    expect([...KA_MANAGE_ROLES]).toEqual([...FP_MANAGE_ROLES]);
    expect(FP_MANAGE_ROLES).not.toContain('GUDANG');
    expect(FP_OPS_WRITE_ROLES).toContain('GUDANG');
  });
});

describe('ADR-004 P0H — transisi HOLD → RELEASED', () => {
  it('wajib reason + sourceId', () => {
    const noReason = applyFoodSafetyTransition(
      { foodSafetyStatus: 'HOLD', foodSafetyHistory: [] },
      { to: 'RELEASED', sourceType: 'KA_FOLLOW_UP', sourceId: 'fu-1', reason: '' },
    );
    expect('error' in noReason).toBe(true);

    const noSource = applyFoodSafetyTransition(
      { foodSafetyStatus: 'HOLD', foodSafetyHistory: [] },
      { to: 'RELEASED', sourceType: 'KA_FOLLOW_UP', reason: 'OK' },
    );
    expect('error' in noSource).toBe(true);
    if ('error' in noSource) expect(noSource.error).toMatch(/sourceId/);

    const ok = applyFoodSafetyTransition(
      { foodSafetyStatus: 'HOLD', foodSafetyHistory: [] },
      {
        to: 'RELEASED',
        sourceType: 'KA_FOLLOW_UP',
        sourceId: 'fu-1',
        reason: 'FU diverifikasi',
        userId: 'u1',
        userName: 'Supervisor',
      },
    );
    expect('error' in ok).toBe(false);
    if (!('error' in ok)) {
      expect(ok.foodSafetyStatus).toBe('RELEASED');
      expect(ok.foodSafetyHistory[0]).toMatchObject({
        fromStatus: 'HOLD',
        toStatus: 'RELEASED',
        sourceType: 'KA_FOLLOW_UP',
        sourceId: 'fu-1',
        note: 'FU diverifikasi',
      });
    }
  });

  it('PENDING tidak bisa langsung RELEASED', () => {
    const res = applyFoodSafetyTransition(
      { foodSafetyStatus: 'PENDING' },
      { to: 'RELEASED', sourceType: 'KA_FOLLOW_UP', sourceId: 'fu-1', reason: 'x' },
    );
    expect('error' in res).toBe(true);
  });
});

describe('ADR-004 P0H — releaseBatchFromVerifiedFollowUp', () => {
  let batchDoc: Record<string, unknown>;
  let updates: Array<Record<string, unknown>>;

  function fakeDb() {
    updates = [];
    return {
      collection: (name: string) => ({
        findOne: async () => (name === 'production_batches' ? batchDoc : null),
        updateOne: async (_f: unknown, update: Record<string, unknown>) => {
          updates.push(update);
          batchDoc = { ...batchDoc, ...((update as { $set?: Record<string, unknown> }).$set || {}) };
          return { modifiedCount: 1 };
        },
      }),
    };
  }

  beforeEach(() => {
    vi.mocked(writeAuditLog).mockClear();
    batchDoc = {
      id: 'batch-1',
      tenantId: 't1',
      batchNo: 'B-1',
      foodSafetyStatus: 'HOLD',
      foodSafetyHistory: [{
        fromStatus: 'PENDING',
        toStatus: 'HOLD',
        sourceType: 'HACCP',
        sourceId: 'hcp-1',
      }],
    };
  });

  it('VERIFIED + case.batchId → RELEASED', async () => {
    const result = await releaseBatchFromVerifiedFollowUp(fakeDb() as never, {
      tenantId: 't1',
      followUp: {
        id: 'fu-1',
        noDokumen: 'FU-001',
        status: 'VERIFIED',
        safetyCaseId: 'case-1',
      },
      safetyCase: { id: 'case-1', batchId: 'batch-1', noDokumen: 'KA-1' },
      reason: 'Evidence OK',
      actor: { userId: 'sup1', userName: 'Supervisor' },
    });

    expect(result.released).toBe(true);
    expect(result.foodSafetyStatus).toBe('RELEASED');
    expect(batchDoc.foodSafetyStatus).toBe('RELEASED');
    const history = batchDoc.foodSafetyHistory as Array<Record<string, unknown>>;
    expect(history.at(-1)).toMatchObject({
      toStatus: 'RELEASED',
      sourceType: 'KA_FOLLOW_UP',
      sourceId: 'fu-1',
      note: 'Evidence OK',
    });
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'FOOD_SAFETY_RELEASE',
        entityType: 'production_batch',
        entityId: 'batch-1',
        metadata: expect.objectContaining({
          sourceType: 'KA_FOLLOW_UP',
          sourceId: 'fu-1',
          safetyCaseId: 'case-1',
        }),
      }),
    );
  });

  it('FU belum VERIFIED → ditolak', async () => {
    const result = await releaseBatchFromVerifiedFollowUp(fakeDb() as never, {
      tenantId: 't1',
      followUp: { id: 'fu-1', noDokumen: 'FU-001', status: 'DONE' },
      safetyCase: { id: 'case-1', batchId: 'batch-1' },
    });
    expect(result).toEqual({ released: false, skipped: 'follow_up_not_verified' });
    expect(updates).toHaveLength(0);
  });

  it('case tanpa batchId (proposed hold) → tidak auto-RELEASE', async () => {
    const result = await releaseBatchFromVerifiedFollowUp(fakeDb() as never, {
      tenantId: 't1',
      followUp: { id: 'fu-1', noDokumen: 'FU-001', status: 'VERIFIED' },
      safetyCase: {
        id: 'case-1',
        proposedHoldBatchIds: ['batch-a', 'batch-b'],
      },
    });
    expect(result.skipped).toBe('no_batch');
    expect(result.released).toBe(false);
  });

  it('idempoten bila sudah RELEASED', async () => {
    batchDoc.foodSafetyStatus = 'RELEASED';
    const result = await releaseBatchFromVerifiedFollowUp(fakeDb() as never, {
      tenantId: 't1',
      followUp: { id: 'fu-1', noDokumen: 'FU-001', status: 'VERIFIED' },
      safetyCase: { id: 'case-1', batchId: 'batch-1' },
    });
    expect(result.skipped).toBe('already_released');
    expect(result.released).toBe(false);
  });

  it('tidak bisa RELEASE hanya dengan ubah status tanpa FU (Recovery gate)', () => {
    const manualNoId = applyFoodSafetyTransition(
      { foodSafetyStatus: 'HOLD' },
      { to: 'RELEASED', sourceType: 'MANUAL', reason: 'lepas saja' },
    );
    expect('error' in manualNoId).toBe(true);

    // MANUAL + sourceId palsu tetap ditolak — wajib KA_FOLLOW_UP
    const manualWithId = applyFoodSafetyTransition(
      { foodSafetyStatus: 'HOLD' },
      { to: 'RELEASED', sourceType: 'MANUAL', sourceId: 'fake', reason: 'lepas saja' },
    );
    expect('error' in manualWithId).toBe(true);
    if ('error' in manualWithId) expect(manualWithId.error).toMatch(/follow-up KA/i);

    const haccpDirect = applyFoodSafetyTransition(
      { foodSafetyStatus: 'HOLD' },
      { to: 'RELEASED', sourceType: 'HACCP', sourceId: 'hcp-1', reason: 'bypass' },
    );
    expect('error' in haccpDirect).toBe(true);
  });

  it('VERIFIED tanpa evidence ditolak di assertFollowUpCanVerify', async () => {
    const { assertFollowUpCanVerify } = await import('@/lib/kitchen-assurance/follow-up');
    expect(assertFollowUpCanVerify({ status: 'DONE', evidenceMedia: [] }))
      .toMatch(/evidence/i);
    expect(assertFollowUpCanVerify({ status: 'OPEN', evidenceMedia: ['x'] }))
      .toMatch(/DONE/i);
    expect(assertFollowUpCanVerify({ status: 'DONE', evidenceMedia: ['ev-1'] })).toBeNull();
  });
});
