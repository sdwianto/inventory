import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  tryAutoCompleteMaintenanceWr,
  tryAutoCompleteWrFromGrn,
} from '@/lib/api/maintenance-wr-loop';

const mockWr = {
  id: 'wr-1',
  tenantId: 't1',
  noWR: 'WR2606000001',
  status: 'IN_PROGRESS',
  resolutionType: 'PO',
  assetId: 'ast-1',
};

function makeDb(collections: Record<string, unknown>) {
  return {
    collection: (name: string) => collections[name],
  } as import('mongodb').Db;
}

describe('maintenance-wr-loop', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('closes WR when GRN posted for maintenance PO', async () => {
    const updates: unknown[] = [];
    const wrCol = {
      findOne: vi.fn().mockResolvedValue({ ...mockWr }),
      updateOne: vi.fn().mockImplementation((_f, patch) => {
        updates.push(patch);
        return Promise.resolve({});
      }),
    };
    const assetsCol = { updateOne: vi.fn() };
    const wrRequests = {
      findOne: vi.fn().mockResolvedValue({ status: 'IN_REPAIR' }),
      updateOne: vi.fn(),
    };
    const db = makeDb({
      maintenance_requests: wrCol,
      assets: assetsCol,
      audit_log: { insertOne: vi.fn() },
    });
    vi.spyOn(
      await import('@/lib/api/maintenance-helpers'),
      'syncAssetStatusFromOpenRequests',
    ).mockResolvedValue(undefined);

    const result = await tryAutoCompleteMaintenanceWr(db, 't1', 'wr-1', {
      kind: 'GRN',
      grnId: 'grn-1',
      noGRN: 'GRN001',
      noPO: 'CPO001',
    });

    expect(result.action).toBe('closed');
    expect(wrCol.updateOne).toHaveBeenCalled();
    const patch = updates[0] as { $set: { status: string; linkedGrnNo: string } };
    expect(patch.$set.status).toBe('CLOSED');
    expect(patch.$set.linkedGrnNo).toBe('GRN001');
  });

  it('skips when PO is not linked to maintenance', async () => {
    const poCol = { findOne: vi.fn().mockResolvedValue({ noPO: 'CPO001' }) };
    const db = makeDb({ customer_purchase_orders: poCol });
    const result = await tryAutoCompleteWrFromGrn(db, {
      id: 'grn-1',
      tenantId: 't1',
      noGRN: 'GRN001',
      noPO: 'CPO001',
    });
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('not_maintenance_po');
  });

  it('resolves WR via maintenance PO on GRN', async () => {
    const poCol = {
      findOne: vi.fn().mockResolvedValue({ maintenanceRequestId: 'wr-1', noPO: 'CPO001' }),
    };
    const wrCol = {
      findOne: vi.fn().mockResolvedValue({ ...mockWr }),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const db = makeDb({
      customer_purchase_orders: poCol,
      maintenance_requests: wrCol,
      assets: { findOne: vi.fn().mockResolvedValue(null) },
      audit_log: { insertOne: vi.fn() },
    });
    vi.spyOn(
      await import('@/lib/api/maintenance-helpers'),
      'syncAssetStatusFromOpenRequests',
    ).mockResolvedValue(undefined);

    const result = await tryAutoCompleteWrFromGrn(db, {
      id: 'grn-1',
      tenantId: 't1',
      noGRN: 'GRN001',
      noPO: 'CPO001',
    });
    expect(result.action).toBe('closed');
    expect(result.wrId).toBe('wr-1');
  });
});
