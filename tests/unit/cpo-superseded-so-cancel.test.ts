import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectCurrentVendorSos,
  isSupersededVendorSo,
} from '@/lib/api/cpo-line-cancel-sync';
import { syncCpoFromVendorEvent } from '@/lib/api/cpo-status-sync';
import { pullSoCancelStateForPo } from '@/lib/api/cpo-so-pull-sync';
import { cancelVendorSoForPoEdit } from '@/lib/api/customer-po-edit-resync';

const fetchSoStatusForCustomerPo = vi.hoisted(() => vi.fn());
const notifySalesPoCancelled = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/cpo-so-fetch', () => ({
  fetchSoStatusForCustomerPo: (...args: unknown[]) => fetchSoStatusForCustomerPo(...args),
}));
vi.mock('@/lib/api/customer-po-cancel-sales', () => ({
  notifySalesPoCancelled: (...args: unknown[]) => notifySalesPoCancelled(...args),
}));
vi.mock('@/lib/api/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Update = { filter: unknown; update: Record<string, unknown> };

function mockDb(po: Record<string, unknown>, calls: string[] = []) {
  const updates: Update[] = [];
  const db = {
    collection: () => ({
      findOne: async () => po,
      updateOne: async (filter: unknown, update: Record<string, unknown>) => {
        calls.push('updateOne');
        updates.push({ filter, update });
        if (update.$set) Object.assign(po, update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    }),
  };
  return { db, updates };
}

/** PO multi-vendor setelah edit rev 1: SO pukid lama digantikan SO baru. */
function editedPo(): Record<string, unknown> {
  return {
    id: 'cpo-50',
    tenantId: 'sppg',
    noPO: 'CPO2609000050',
    status: 'SUBMITTED',
    vendorTenantId: 'multi',
    editRevision: 1,
    items: [
      { lineId: 'l-beras', kode: 'B335256', nama: 'Beras', qty: 2, vendorTenantId: 'toko-palapa' },
      { lineId: 'l-susu', kode: 'B070870', nama: 'Susu', qty: 1370, vendorTenantId: 'pukid' },
    ],
    vendorSubmissions: [
      { vendorTenantId: 'toko-palapa', vendorSoId: 'so-palapa-new', vendorNoSO: 'SO2609000013', status: 'SYNCED' },
      { vendorTenantId: 'pukid', vendorSoId: 'so-pukid-new', vendorNoSO: 'SO2609000004', status: 'SYNCED' },
    ],
    supersededVendorSos: [
      { vendorTenantId: 'toko-palapa', salesOrderId: 'so-palapa-old', noSO: 'SO2609000012', editRevision: 1 },
      { vendorTenantId: 'pukid', salesOrderId: 'so-pukid-old', noSO: 'SO2609000003', editRevision: 1 },
    ],
  };
}

describe('isSupersededVendorSo', () => {
  it('flags SO listed as superseded, not the current one', () => {
    const po = editedPo();
    expect(isSupersededVendorSo(po, { salesOrderId: 'so-pukid-old', vendorTenantId: 'pukid' })).toBe(true);
    expect(isSupersededVendorSo(po, { noSO: 'SO2609000003', vendorTenantId: 'pukid' })).toBe(true);
    expect(isSupersededVendorSo(po, { salesOrderId: 'so-pukid-new', vendorTenantId: 'pukid' })).toBe(false);
  });

  it('does not match noSO across vendors', () => {
    const po = editedPo();
    expect(isSupersededVendorSo(po, { noSO: 'SO2609000003', vendorTenantId: 'zulmy' })).toBe(false);
    expect(isSupersededVendorSo(po, { noSO: 'SO2609000003' })).toBe(false);
  });

  it('flags Edit PO cancel reason even without superseded list', () => {
    const po = { ...editedPo(), supersededVendorSos: undefined };
    expect(isSupersededVendorSo(po, {
      salesOrderId: 'so-pukid-old',
      vendorTenantId: 'pukid',
      reason: 'Edit PO (rev 1): koreksi item beras',
    })).toBe(true);
    expect(isSupersededVendorSo(po, {
      salesOrderId: 'so-pukid-old',
      vendorTenantId: 'pukid',
      reason: 'Stok habis',
    })).toBe(false);
  });

  it('collectCurrentVendorSos skips multi-vendor summary noSO', () => {
    const list = collectCurrentVendorSos({
      vendorTenantId: 'multi',
      vendorSoId: 'so-a',
      vendorNoSO: 'SO1, SO2',
      vendorSubmissions: [
        { vendorTenantId: 'a', vendorSoId: 'so-a', vendorNoSO: 'SO1' },
        { vendorTenantId: 'b', vendorSoId: 'so-b', vendorNoSO: 'SO2' },
      ],
    }, 2);
    expect(list.map((s) => s.noSO).filter(Boolean)).toEqual(['SO1', 'SO2']);
    expect(list.every((s) => s.editRevision === 2)).toBe(true);
  });
});

describe('syncCpoFromVendorEvent sales_order.cancelled after PO edit', () => {
  it('ignores stale cancel for superseded SO of the same vendor', async () => {
    const po = editedPo();
    const { db, updates } = mockDb(po);
    const result = await syncCpoFromVendorEvent(db as never, 'sppg', 'sales_order.cancelled', {
      customerPoId: 'cpo-50',
      salesOrderId: 'so-pukid-old',
      noSO: 'SO2609000003',
      vendorTenantId: 'pukid',
      cancelledItems: [],
      reason: 'Edit PO (rev 1): koreksi item beras',
    });
    expect(result).toMatchObject({ action: 'skipped', reason: 'superseded_so' });
    const set = updates[0]?.update.$set as Record<string, unknown>;
    expect(set.items).toBeUndefined();
    expect(set.status).toBeUndefined();
    const susu = (po.items as Array<{ kode: string; cancelled?: boolean }>).find((i) => i.kode === 'B070870');
    expect(susu?.cancelled).toBeFalsy();
  });

  it('still cancels vendor lines when the current SO is cancelled', async () => {
    const po = editedPo();
    const { db, updates } = mockDb(po);
    await syncCpoFromVendorEvent(db as never, 'sppg', 'sales_order.cancelled', {
      customerPoId: 'cpo-50',
      salesOrderId: 'so-pukid-new',
      noSO: 'SO2609000004',
      vendorTenantId: 'pukid',
      cancelledItems: [],
      reason: 'Stok vendor habis',
    });
    const items = updates[0]?.update.$set?.items as Array<{ kode: string; cancelled?: boolean }>;
    expect(items.find((i) => i.kode === 'B070870')?.cancelled).toBe(true);
    expect(items.find((i) => i.kode === 'B335256')?.cancelled).toBeFalsy();
  });

  it('ignores sales_order.updated from superseded SO', async () => {
    const po = editedPo();
    const { db } = mockDb(po);
    const result = await syncCpoFromVendorEvent(db as never, 'sppg', 'sales_order.updated', {
      customerPoId: 'cpo-50',
      salesOrderId: 'so-pukid-old',
      noSO: 'SO2609000003',
      vendorTenantId: 'pukid',
      items: [],
    });
    expect(result).toMatchObject({ action: 'skipped', reason: 'superseded_so' });
  });
});

describe('pullSoCancelStateForPo after PO edit', () => {
  beforeEach(() => fetchSoStatusForCustomerPo.mockReset());

  it('skips CANCELLED payload of a superseded SO', async () => {
    const po = editedPo();
    fetchSoStatusForCustomerPo.mockImplementation(async (...args: unknown[]) => (
      (args[2] as { vendorTenantId?: string } | undefined)?.vendorTenantId === 'pukid'
        ? { payload: { salesOrderId: 'so-pukid-old', noSO: 'SO2609000003', status: 'CANCELLED', cancelReason: 'Edit PO (rev 1): x' } }
        : { payload: { salesOrderId: 'so-palapa-new', noSO: 'SO2609000013', status: 'CONFIRMED', items: [{ kode: 'B335256', qty: 2 }] } }
    ));
    const { db, updates } = mockDb(po);
    await pullSoCancelStateForPo(db as never, po);
    const written = updates[0]?.update.$set?.items as Array<{ kode: string; cancelled?: boolean }> | undefined;
    const items = written || (po.items as Array<{ kode: string; cancelled?: boolean }>);
    expect(items.find((i) => i.kode === 'B070870')?.cancelled).toBeFalsy();
  });
});

describe('cancelVendorSoForPoEdit', () => {
  beforeEach(() => notifySalesPoCancelled.mockReset());

  it('stores supersededVendorSos before notifying sales', async () => {
    const calls: string[] = [];
    notifySalesPoCancelled.mockImplementation(async () => {
      calls.push('notify');
      return { cancelled: [], errors: [] };
    });
    const po = {
      id: 'cpo-50',
      vendorTenantId: 'multi',
      vendorSubmissions: [
        { vendorTenantId: 'pukid', vendorSoId: 'so-pukid-old', vendorNoSO: 'SO2609000003' },
      ],
    };
    const { db, updates } = mockDb(po, calls);
    const res = await cancelVendorSoForPoEdit(db as never, po, { editRevision: 1, editReason: 'koreksi' });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(['updateOne', 'notify']);
    const pushed = (updates[0]?.update.$push as { supersededVendorSos: { $each: Array<Record<string, unknown>> } })
      .supersededVendorSos.$each;
    expect(pushed).toEqual([
      expect.objectContaining({ vendorTenantId: 'pukid', salesOrderId: 'so-pukid-old', noSO: 'SO2609000003', editRevision: 1 }),
    ]);
  });
});
