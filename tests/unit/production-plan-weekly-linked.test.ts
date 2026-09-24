import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleProductionPlans } from '@/lib/api/handlers/production-plans';
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

const findOne = vi.fn();
const updateOne = vi.fn();

function mockDb() {
  return {
    collection: () => ({
      findOne,
      updateOne,
    }),
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

const linkedPlan = {
  id: 'p-linked',
  tenantId: 't1',
  noDokumen: 'RPN-2029-001',
  tanggal: '2029-03-05',
  kitchenId: 'k1',
  weeklyMenuPlanId: 'w1',
  status: 'DRAFT',
  lines: [{ recipeId: 'r1', targetPorsi: 10 }],
  kategoriPorsiList: ['PORSI_KECIL'],
};

describe('production-plan weekly-linked integrity', () => {
  beforeEach(() => {
    findOne.mockReset();
    updateOne.mockReset();
    updateOne.mockResolvedValue({ matchedCount: 1 });
  });

  it('POST ad-hoc returns 409 when active weekly-linked RPN exists', async () => {
    findOne.mockResolvedValue(linkedPlan);
    const res = await handleProductionPlans(ctx({
      method: 'POST',
      body: {
        tanggal: '2029-03-05',
        kitchenId: 'k1',
        kategoriPorsiList: ['PORSI_KECIL'],
        catatan: 'ADHOC: masak extra posyandu',
        lines: [{ recipeId: 'r1', targetPorsi: 10, kategoriPorsiList: ['PORSI_KECIL'] }],
      },
    }));
    expect(res?.status).toBe(409);
    const json = await res?.json();
    expect(json.error).toMatch(/RPN-2029-001/);
    expect(json.error).toMatch(/Perencanaan Menu/);
  });

  it('PUT lines on weekly-linked RPN returns 409', async () => {
    findOne.mockResolvedValue(linkedPlan);
    const res = await handleProductionPlans(ctx({
      method: 'PUT',
      route: '/production-plans/p-linked',
      path: ['production-plans', 'p-linked'],
      url: new URL('http://local/api/production-plans/p-linked'),
      request: new Request('http://local/api/production-plans/p-linked', { method: 'PUT' }),
      body: {
        lines: [{ recipeId: 'r2', targetPorsi: 20, kategoriPorsiList: ['PORSI_KECIL'] }],
      },
    }));
    expect(res?.status).toBe(409);
    const json = await res?.json();
    expect(json.error).toMatch(/papan minggu/);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('PUT materialOverrides on weekly-linked RPN is allowed', async () => {
    findOne.mockResolvedValue(linkedPlan);
    const res = await handleProductionPlans(ctx({
      method: 'PUT',
      route: '/production-plans/p-linked',
      path: ['production-plans', 'p-linked'],
      url: new URL('http://local/api/production-plans/p-linked'),
      request: new Request('http://local/api/production-plans/p-linked', { method: 'PUT' }),
      body: {
        materialOverrides: [{
          recipeId: 'r1',
          productId: 'prod-1',
          qty: 2,
        }],
        catatan: 'qty basah disesuaikan',
      },
    }));
    expect(res?.status).toBe(200);
    expect(updateOne).toHaveBeenCalled();
  });
});
