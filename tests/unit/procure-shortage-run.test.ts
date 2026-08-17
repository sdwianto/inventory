import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  handleCustomerPo,
  handlePurchaseRequirements,
  buildPlanMaterialExplosion,
  nextFpDocNumber,
  writeAuditLog,
} = vi.hoisted(() => ({
  handleCustomerPo: vi.fn(),
  handlePurchaseRequirements: vi.fn(),
  buildPlanMaterialExplosion: vi.fn(),
  nextFpDocNumber: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('@/lib/api/handlers/customer-po', () => ({
  handleCustomerPo,
}));

vi.mock('@/lib/api/handlers/purchase-requirements', () => ({
  handlePurchaseRequirements,
}));

vi.mock('@/lib/api/handlers/material-requirements', () => ({
  buildPlanMaterialExplosion,
}));

vi.mock('@/lib/food-production/document-number', () => ({
  nextFpDocNumber,
}));

vi.mock('@/lib/api/audit-log', () => ({
  writeAuditLog,
  auditActor: () => ({ userId: 'u1', userName: 'Tester' }),
}));

import {
  runProcureShortageFromPlan,
  runRefreshProcureDraftFromPlan,
} from '@/lib/api/procure-shortage-run';

function mockJsonResponse(body: Record<string, unknown>, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function makeDb(plan: Record<string, unknown> | null, linkedPo: Record<string, unknown> | null) {
  const collections: Record<string, unknown> = {
    production_plans: {
      findOne: vi.fn().mockResolvedValue(plan),
    },
    customer_purchase_orders: {
      findOne: vi.fn().mockResolvedValue(linkedPo),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    },
    material_requirements: {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      insertOne: vi.fn().mockResolvedValue({ insertedId: 'mrp-1' }),
    },
    purchase_requirements: {
      find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    },
  };

  return {
    collection: (name: string) => collections[name] || {
      findOne: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      insertOne: vi.fn().mockResolvedValue({ insertedId: 'x' }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
    },
  };
}

const scopeAuth = {
  tenantId: 'tenant-1',
  role: 'MASTER',
  userId: 'u1',
  userName: 'Tester',
} as const;

const ctx = {
  auth: scopeAuth,
  request: {} as Request,
  url: new URL('http://localhost/api/production-plans/p1/procure-shortage'),
};

const basePlan = {
  id: 'p1',
  tenantId: 'tenant-1',
  noDokumen: 'RPN-001',
  status: 'APPROVED',
  tanggal: '2026-08-18',
  kitchenId: 'k1',
  kitchenNama: 'Dapur 1',
};

describe('procure-shortage-run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nextFpDocNumber.mockResolvedValue('KBH-001');
    buildPlanMaterialExplosion.mockResolvedValue({
      warehouseKode: 'GKERING',
      lines: [{ productId: 'a', shortage: true }],
      summary: { shortageCount: 1 },
      acuanByKategori: null,
    });
    handlePurchaseRequirements.mockResolvedValue(
      mockJsonResponse({ draftCpoId: 'cpo-1', draftCpoNo: 'PO-001' }),
    );
  });

  it('returns existing linkedPo without creating draft', async () => {
    const db = makeDb(basePlan, { id: 'cpo-old', noPO: 'PO-OLD', status: 'APPROVED' });
    const result = await runProcureShortageFromPlan(db as never, ctx, {
      productionPlanId: 'p1',
      scopeAuth: scopeAuth as never,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.linkedPo?.id).toBe('cpo-old');
      expect(result.draftCpoId).toBeUndefined();
    }
    expect(buildPlanMaterialExplosion).not.toHaveBeenCalled();
    expect(handleCustomerPo).not.toHaveBeenCalled();
    expect(handlePurchaseRequirements).not.toHaveBeenCalled();
  });

  it('creates Draft PO without auto-submit to vendor', async () => {
    const db = makeDb(basePlan, null);
    const result = await runProcureShortageFromPlan(db as never, ctx, {
      productionPlanId: 'p1',
      scopeAuth: scopeAuth as never,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.poStatus).toBe('DRAFT');
      expect(result.draftCpoId).toBe('cpo-1');
      expect(result.draftCpoNo).toBe('PO-001');
      expect(result.message).toContain('review');
    }
    expect(handlePurchaseRequirements).toHaveBeenCalledOnce();
    expect(handleCustomerPo).not.toHaveBeenCalled();
  });

  it('returns materialsReady when no shortage', async () => {
    buildPlanMaterialExplosion.mockResolvedValue({
      warehouseKode: 'GKERING',
      lines: [],
      summary: { shortageCount: 0 },
      acuanByKategori: null,
    });
    const db = makeDb(basePlan, null);
    const result = await runProcureShortageFromPlan(db as never, ctx, {
      productionPlanId: 'p1',
      scopeAuth: scopeAuth as never,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.materialsReady).toBe(true);
      expect(result.shortageCount).toBe(0);
    }
    expect(handlePurchaseRequirements).not.toHaveBeenCalled();
    expect(handleCustomerPo).not.toHaveBeenCalled();
  });

  it('refresh replaces Draft linked PO and returns new draft', async () => {
    const db = makeDb(basePlan, { id: 'cpo-old', noPO: 'PO-OLD', status: 'DRAFT' });
    const result = await runRefreshProcureDraftFromPlan(db as never, ctx, {
      productionPlanId: 'p1',
      scopeAuth: scopeAuth as never,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.refreshed).toBe(true);
      expect(result.poStatus).toBe('DRAFT');
      expect(result.draftCpoId).toBe('cpo-1');
    }
    expect(handleCustomerPo).not.toHaveBeenCalled();
  });

  it('refresh rejects when linked PO is APPROVED', async () => {
    const db = makeDb(basePlan, { id: 'cpo-old', noPO: 'PO-OLD', status: 'APPROVED' });
    const result = await runRefreshProcureDraftFromPlan(db as never, ctx, {
      productionPlanId: 'p1',
      scopeAuth: scopeAuth as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('tidak bisa diperbarui');
    }
  });
});
