import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleProductionPlans } from '@/lib/api/handlers/production-plans';
import { writeAuditLog } from '@/lib/api/audit-log';
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
} from '@/lib/food-production/material-requirement';
import { PURCHASE_REQUIREMENTS_COLLECTION } from '@/lib/food-production/purchase-requirement';
import { PRODUCTION_PLANS_COLLECTION } from '@/lib/food-production/production-plan';
import { MATERIAL_ISSUES_COLLECTION } from '@/lib/food-production/material-issue';
import {
  MENU_REVISE_REPUBLISH_REQUIRED,
  WEEKLY_MENU_PUBLISH_NOTE,
} from '@/lib/food-production/fp-flow';
import type { HandlerContext } from '@/types/api/handler';

vi.mock('@/lib/api/require-auth', () => ({
  requireRole: () => null,
}));

vi.mock('@/lib/api/tenant-master', () => ({
  resolveOperationalScope: () => ({
    denied: null,
    scopeAuth: {
      tenantId: 't1',
      role: 'MASTER',
      userId: 'u1',
      name: 'U',
      isMaster: true,
    },
    tenantId: 't1',
  }),
  withTenantFilter: (_scope: unknown, filter: Record<string, unknown>) => ({
    tenantId: 't1',
    ...filter,
  }),
  tenantIdForWrite: () => 't1',
}));

vi.mock('@/lib/api/transaction', () => ({
  runInTransactionOrFallback: async (fn: (c: { db: unknown }) => unknown) => fn({ db: mockDb() }),
  txOpts: () => ({}),
}));

vi.mock('@/lib/api/audit-log', () => ({
  writeAuditLog: vi.fn(),
  auditActor: () => ({ userId: 'u1', userName: 'U' }),
}));

const cols: Record<string, { findOne: ReturnType<typeof vi.fn>; updateOne: ReturnType<typeof vi.fn> }> = {};

function col(name: string) {
  if (!cols[name]) {
    cols[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    };
  }
  return cols[name];
}

function mockDb() {
  return {
    collection: (name: string) => col(name),
  };
}

function ctx(partial: Partial<HandlerContext>): HandlerContext {
  return {
    db: mockDb() as never,
    route: '/production-plans',
    method: 'POST',
    path: ['production-plans'],
    body: {},
    url: new URL('http://local/api/production-plans'),
    auth: { tenantId: 't1', role: 'MASTER', userId: 'u1', name: 'U', isMaster: true },
    request: new Request('http://local/api/production-plans', { method: 'POST' }),
    ...partial,
  } as HandlerContext;
}

const approvedPlan = {
  id: 'p-approved',
  tenantId: 't1',
  noDokumen: 'RPN2609000008',
  tanggal: '2029-03-05',
  kitchenId: 'k1',
  weeklyMenuPlanId: 'w1',
  status: 'APPROVED',
  lines: [{ recipeId: 'r1', targetPorsi: 10 }],
  history: [{
    at: new Date('2029-03-04T00:00:00Z'),
    fromStatus: 'SUBMITTED',
    toStatus: 'APPROVED',
    note: 'Disetujui gizi',
  }],
};

function reviseCtx(method: 'GET' | 'POST', body?: Record<string, unknown>): HandlerContext {
  return ctx({
    method,
    route: '/production-plans/p-approved/revise-menu',
    path: ['production-plans', 'p-approved', 'revise-menu'],
    url: new URL('http://local/api/production-plans/p-approved/revise-menu'),
    request: new Request('http://local/api/production-plans/p-approved/revise-menu', { method }),
    body: body || {},
  });
}

describe('production-plan revise-menu change order', () => {
  beforeEach(() => {
    for (const name of Object.keys(cols)) delete cols[name];
    vi.mocked(writeAuditLog).mockClear();
  });

  it('POST APPROVED → SUBMITTED with history note and audit; does not rewrite PO', async () => {
    col(PRODUCTION_PLANS_COLLECTION).findOne
      .mockResolvedValueOnce(approvedPlan)
      .mockResolvedValueOnce({ ...approvedPlan, status: 'SUBMITTED' });

    const res = await handleProductionPlans(reviseCtx('POST', {
      reason: 'bahan serai habis di pasar',
    }));
    expect(res?.status).toBe(200);
    const json = await res?.json();
    expect(json.status).toBe('SUBMITTED');

    const set = col(PRODUCTION_PLANS_COLLECTION).updateOne.mock.calls[0][1].$set as {
      status: string;
      history: Array<{ fromStatus: string; toStatus: string; note?: string }>;
    };
    expect(set.status).toBe('SUBMITTED');
    expect(set.history.at(-1)?.fromStatus).toBe('APPROVED');
    expect(set.history.at(-1)?.toStatus).toBe('SUBMITTED');
    expect(set.history.at(-1)?.note).toBe('REVISI MENU: bahan serai habis di pasar');
    expect(set.history[0]?.note).toBe('Disetujui gizi');

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'PRODUCTION_PLAN_MENU_REVISE',
        summary: expect.stringMatching(/bahan serai habis di pasar/),
      }),
      undefined,
    );
    expect(col('customer_purchase_orders').updateOne).not.toHaveBeenCalled();
    expect(col(MATERIAL_REQUIREMENTS_COLLECTION).updateOne).not.toHaveBeenCalled();
    expect(col(PURCHASE_REQUIREMENTS_COLLECTION).updateOne).not.toHaveBeenCalled();
  });

  it('rejects short reason and non-APPROVED status', async () => {
    const short = await handleProductionPlans(reviseCtx('POST', { reason: 'pendek' }));
    expect(short?.status).toBe(400);
    expect((await short?.json()).error).toMatch(/minimal 8/i);
    expect(col(PRODUCTION_PLANS_COLLECTION).updateOne).not.toHaveBeenCalled();

    col(PRODUCTION_PLANS_COLLECTION).findOne.mockResolvedValue({
      ...approvedPlan,
      status: 'PROCESSING',
    });
    const processing = await handleProductionPlans(reviseCtx('POST', {
      reason: 'bahan serai habis di pasar',
    }));
    expect(processing?.status).toBe(409);
    expect((await processing?.json()).error).toMatch(/Disetujui/);

    col(PRODUCTION_PLANS_COLLECTION).findOne.mockResolvedValue({
      ...approvedPlan,
      status: 'DRAFT',
    });
    const draft = await handleProductionPlans(reviseCtx('POST', {
      reason: 'bahan serai habis di pasar',
    }));
    expect(draft?.status).toBe(409);
  });

  it('does not allow APPROVED → SUBMITTED via generic status endpoint', async () => {
    col(PRODUCTION_PLANS_COLLECTION).findOne.mockResolvedValue(approvedPlan);
    const res = await handleProductionPlans(ctx({
      method: 'POST',
      route: '/production-plans/p-approved/status',
      path: ['production-plans', 'p-approved', 'status'],
      url: new URL('http://local/api/production-plans/p-approved/status'),
      request: new Request('http://local/api/production-plans/p-approved/status', { method: 'POST' }),
      body: { status: 'SUBMITTED' },
    }));
    expect(res?.status).toBe(400);
    expect((await res?.json()).error).toMatch(/tidak boleh dari APPROVED ke SUBMITTED/i);
    expect(col(PRODUCTION_PLANS_COLLECTION).updateOne).not.toHaveBeenCalled();
  });

  it('GET returns MRP/PR/PO impact without mutating', async () => {
    col(PRODUCTION_PLANS_COLLECTION).findOne.mockResolvedValue(approvedPlan);
    col(MATERIAL_REQUIREMENTS_COLLECTION).findOne.mockResolvedValue({
      noDokumen: 'KBH1',
      status: 'APPROVED',
    });
    col(PURCHASE_REQUIREMENTS_COLLECTION).findOne.mockResolvedValue({
      noDokumen: 'PRB1',
      status: 'APPROVED',
    });
    col('customer_purchase_orders').findOne.mockResolvedValue({
      noPO: 'CPO1',
      status: 'SUBMITTED',
    });

    const res = await handleProductionPlans(reviseCtx('GET'));
    expect(res?.status).toBe(200);
    const json = await res?.json();
    expect(json.canRevise).toBe(true);
    expect(json.impact.mrpNo).toBe('KBH1');
    expect(json.impact.prNo).toBe('PRB1');
    expect(json.impact.poNo).toBe('CPO1');
    expect(json.warnings.join(' ')).toMatch(/tidak diubah otomatis/);
    expect(json.warnings.join(' ')).toMatch(/amandemen manual/);
    expect(col(PRODUCTION_PLANS_COLLECTION).updateOne).not.toHaveBeenCalled();
  });

  it('POST 409 when material issue exists — does not unlock the board', async () => {
    col(PRODUCTION_PLANS_COLLECTION).findOne.mockResolvedValue(approvedPlan);
    col(MATERIAL_ISSUES_COLLECTION).findOne.mockResolvedValue({
      noDokumen: 'PBL1',
      status: 'COMPLETED',
    });
    const res = await handleProductionPlans(reviseCtx('POST', {
      reason: 'bahan serai habis di pasar',
    }));
    expect(res?.status).toBe(409);
    expect((await res?.json()).error).toMatch(/dikeluarkan/);
    expect(col(PRODUCTION_PLANS_COLLECTION).updateOne).not.toHaveBeenCalled();
  });

  it('GET canRevise=false when issue exists', async () => {
    col(PRODUCTION_PLANS_COLLECTION).findOne.mockResolvedValue(approvedPlan);
    col(MATERIAL_ISSUES_COLLECTION).findOne.mockResolvedValue({
      noDokumen: 'PBL1',
      status: 'COMPLETED',
    });
    const res = await handleProductionPlans(reviseCtx('GET'));
    expect(res?.status).toBe(200);
    const json = await res?.json();
    expect(json.canRevise).toBe(false);
    expect(json.blockedReason).toMatch(/PBL1/);
  });

  it('rejects re-approve until weekly republish after menu revise', async () => {
    col(PRODUCTION_PLANS_COLLECTION).findOne.mockResolvedValue({
      ...approvedPlan,
      status: 'SUBMITTED',
      history: [
        { fromStatus: 'SUBMITTED', toStatus: 'APPROVED', note: 'ok' },
        { fromStatus: 'APPROVED', toStatus: 'SUBMITTED', note: 'REVISI MENU: bahan serai habis di pasar' },
      ],
    });
    const res = await handleProductionPlans(ctx({
      method: 'POST',
      route: '/production-plans/p-approved/status',
      path: ['production-plans', 'p-approved', 'status'],
      url: new URL('http://local/api/production-plans/p-approved/status'),
      request: new Request('http://local/api/production-plans/p-approved/status', { method: 'POST' }),
      body: { status: 'APPROVED' },
    }));
    expect(res?.status).toBe(409);
    expect((await res?.json()).error).toBe(MENU_REVISE_REPUBLISH_REQUIRED);
    expect(col(PRODUCTION_PLANS_COLLECTION).updateOne).not.toHaveBeenCalled();
  });

  it('allows re-approve after weekly republish note', async () => {
    col(PRODUCTION_PLANS_COLLECTION).findOne.mockResolvedValue({
      ...approvedPlan,
      status: 'SUBMITTED',
      history: [
        { fromStatus: 'APPROVED', toStatus: 'SUBMITTED', note: 'REVISI MENU: bahan serai habis di pasar' },
        { fromStatus: 'SUBMITTED', toStatus: 'SUBMITTED', note: WEEKLY_MENU_PUBLISH_NOTE },
      ],
    });
    const res = await handleProductionPlans(ctx({
      method: 'POST',
      route: '/production-plans/p-approved/status',
      path: ['production-plans', 'p-approved', 'status'],
      url: new URL('http://local/api/production-plans/p-approved/status'),
      request: new Request('http://local/api/production-plans/p-approved/status', { method: 'POST' }),
      body: { status: 'APPROVED' },
    }));
    // kitchen/line enrich runs after republish gate — no kitchen mock → 400 dapur
    expect(res?.status).not.toBe(409);
    expect((await res?.json()).error).not.toBe(MENU_REVISE_REPUBLISH_REQUIRED);
  });

  it('blocks Kembalikan to Draft after the RPN was approved', async () => {
    col(PRODUCTION_PLANS_COLLECTION).findOne.mockResolvedValue({
      ...approvedPlan,
      status: 'SUBMITTED',
      history: [
        { fromStatus: 'SUBMITTED', toStatus: 'APPROVED', note: 'ok' },
        { fromStatus: 'APPROVED', toStatus: 'SUBMITTED', note: 'REVISI MENU: bahan serai habis di pasar' },
      ],
    });
    const res = await handleProductionPlans(ctx({
      method: 'POST',
      route: '/production-plans/p-approved/status',
      path: ['production-plans', 'p-approved', 'status'],
      url: new URL('http://local/api/production-plans/p-approved/status'),
      request: new Request('http://local/api/production-plans/p-approved/status', { method: 'POST' }),
      body: { status: 'DRAFT' },
    }));
    expect(res?.status).toBe(409);
    expect((await res?.json()).error).toMatch(/tidak dikembalikan ke Draft/);
    expect(col(PRODUCTION_PLANS_COLLECTION).updateOne).not.toHaveBeenCalled();
  });
});
