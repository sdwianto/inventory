import { describe, expect, it } from 'vitest';
import { fixHutangApprovalIfNeeded, reconcileHutangItemsFromGrn } from '@/lib/api/hutang-reconcile';
import type { GrnDoc, HutangDoc } from '@/types/documents';

function mockDb(updates: Array<{ collection: string; filter: Record<string, unknown>; set: Record<string, unknown> }>) {
  return {
    collection: (name: string) => ({
      updateOne: async (filter: Record<string, unknown>, patch: { $set?: Record<string, unknown> }) => {
        if (patch.$set) updates.push({ collection: name, filter, set: patch.$set });
        return { matchedCount: 1, modifiedCount: 1 };
      },
    }),
  } as unknown as import('mongodb').Db;
}

function baseHutang(overrides: Partial<HutangDoc> = {}): HutangDoc {
  return {
    id: 'ht-1',
    tenantId: 'sppg',
    noHutang: 'HT2608000012',
    noInvoice: 'INV2608000007',
    referenceType: 'VENDOR_INVOICE',
    approvalStatus: 'PENDING_REVIEW',
    status: 'PENDING_REVIEW',
    total: 40000,
    terbayar: 0,
    sisa: 40000,
    items: [{ lineId: 'line-1', kode: 'B203740', nama: 'Kelengkeng', qty: 1, harga: 40000 }],
    ...overrides,
  } as HutangDoc;
}

function baseGrn(overrides: Partial<GrnDoc> = {}): GrnDoc {
  return {
    id: 'grn-1',
    tenantId: 'sppg',
    status: 'POSTED',
    receivedTotal: 0,
    items: [{ lineId: 'line-1', qtyOrdered: 1, qtyReceived: 0, qtyRejected: 1, harga: 40000 }],
    ...overrides,
  } as GrnDoc;
}

describe('reconcileHutangItemsFromGrn', () => {
  it('zeroes qty/jumlah for a fully rejected line', () => {
    const result = reconcileHutangItemsFromGrn(
      [{ lineId: 'line-1', qty: 1, harga: 40000 }],
      baseGrn().items,
    );
    expect(result.changed).toBe(true);
    expect(result.items[0].qty).toBe(0);
    expect(result.items[0].jumlah).toBe(0);
    expect(result.total).toBe(0);
  });

  it('leaves an already-correct line untouched (no-op)', () => {
    const result = reconcileHutangItemsFromGrn(
      [{ lineId: 'line-1', qty: 1, harga: 40000 }],
      [{ lineId: 'line-1', qtyOrdered: 1, qtyReceived: 1, qtyRejected: 0, harga: 40000 }],
    );
    expect(result.changed).toBe(false);
    expect(result.total).toBe(40000);
  });

  it('leaves a line with no matching GRN lineId untouched (no guessing)', () => {
    const result = reconcileHutangItemsFromGrn(
      [{ lineId: 'unknown-line', qty: 2, harga: 5000 }],
      baseGrn().items,
    );
    expect(result.changed).toBe(false);
    expect(result.items[0].qty).toBe(2);
  });
});

describe('fixHutangApprovalIfNeeded', () => {
  it('corrects total and items to 0 when the GRN line was fully rejected', async () => {
    const updates: Array<{ collection: string; filter: Record<string, unknown>; set: Record<string, unknown> }> = [];
    const db = mockDb(updates);
    const hutang = baseHutang();
    const grn = baseGrn();

    const changed = await fixHutangApprovalIfNeeded(db, hutang, grn);

    expect(changed).toBe(true);
    const hutangUpdates = updates.filter((u) => u.collection === 'hutang');
    expect(hutangUpdates).toHaveLength(1);
    expect(hutangUpdates[0].set.total).toBe(0);
    expect(hutangUpdates[0].set.sisa).toBe(0);
    expect((hutangUpdates[0].set.items as Array<{ qty: number }>)[0].qty).toBe(0);
  });

  it('corrects only the rejected line when the GRN was partially rejected', async () => {
    const updates: Array<{ collection: string; filter: Record<string, unknown>; set: Record<string, unknown> }> = [];
    const db = mockDb(updates);
    const hutang = baseHutang({
      total: 90000,
      sisa: 90000,
      items: [
        { lineId: 'line-1', kode: 'B203740', nama: 'Kelengkeng', qty: 1, harga: 40000 },
        { lineId: 'line-2', kode: 'B999999', nama: 'Melon', qty: 1, harga: 50000 },
      ],
    });
    const grn = baseGrn({
      receivedTotal: 50000,
      items: [
        { lineId: 'line-1', qtyOrdered: 1, qtyReceived: 0, qtyRejected: 1, harga: 40000 },
        { lineId: 'line-2', qtyOrdered: 1, qtyReceived: 1, qtyRejected: 0, harga: 50000 },
      ],
    });

    const changed = await fixHutangApprovalIfNeeded(db, hutang, grn);

    expect(changed).toBe(true);
    const set = updates.find((u) => u.collection === 'hutang')!.set;
    expect(set.total).toBe(50000);
    const items = set.items as Array<{ lineId: string; qty: number }>;
    expect(items.find((it) => it.lineId === 'line-1')!.qty).toBe(0);
    expect(items.find((it) => it.lineId === 'line-2')!.qty).toBe(1);
  });

  it('does not write anything when the invoice already matches what was received', async () => {
    const updates: Array<{ collection: string; filter: Record<string, unknown>; set: Record<string, unknown> }> = [];
    const db = mockDb(updates);
    const hutang = baseHutang({
      total: 40000,
      sisa: 40000,
      items: [{ lineId: 'line-1', kode: 'B203740', nama: 'Kelengkeng', qty: 1, harga: 40000 }],
    });
    const grn = baseGrn({
      receivedTotal: 40000,
      items: [{ lineId: 'line-1', qtyOrdered: 1, qtyReceived: 1, qtyRejected: 0, harga: 40000 }],
    });

    const changed = await fixHutangApprovalIfNeeded(db, hutang, grn);

    expect(changed).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('also corrects items/total on the reset-to-PENDING_REVIEW branch (stale/illegitimate approval)', async () => {
    // Distinct code path from the other tests: approvalStatus isn't PENDING_REVIEW here, and
    // has no legitimate approvedBy, so vendorInvoiceNeedsPendingReview() routes through
    // resetVendorHutangToPendingReview() instead of the plain totalMismatch $set branch.
    const updates: Array<{ collection: string; filter: Record<string, unknown>; set: Record<string, unknown> }> = [];
    const db = mockDb(updates);
    const hutang = baseHutang({
      approvalStatus: 'APPROVED',
      status: 'APPROVED',
      total: 40000,
      sisa: 40000,
      items: [{ lineId: 'line-1', kode: 'B203740', nama: 'Kelengkeng', qty: 1, harga: 40000 }],
    });
    const grn = baseGrn();

    const changed = await fixHutangApprovalIfNeeded(db, hutang, grn);

    expect(changed).toBe(true);
    const set = updates.find((u) => u.collection === 'hutang')!.set;
    expect(set.approvalStatus).toBe('PENDING_REVIEW');
    expect(set.total).toBe(0);
    expect(set.sisa).toBe(0);
    expect((set.items as Array<{ qty: number }>)[0].qty).toBe(0);
  });

  it('trusts per-line qtyReceived over a stale grn.receivedTotal cache', async () => {
    // Regression: grn.receivedTotal is a denormalized cache that can go stale relative to
    // items[].qtyReceived (e.g. after a manual correction that only touched the line, not the
    // top-level field). The per-line reconciliation must win, not the stale cached total.
    const updates: Array<{ collection: string; filter: Record<string, unknown>; set: Record<string, unknown> }> = [];
    const db = mockDb(updates);
    const hutang = baseHutang({
      total: 0,
      sisa: 0,
      items: [{ lineId: 'line-1', kode: 'B203740', nama: 'Kelengkeng', qty: 0, harga: 40000 }],
    });
    const grn = baseGrn({
      receivedTotal: 40000, // stale — line itself already shows qtyReceived: 0 below
      items: [{ lineId: 'line-1', qtyOrdered: 1, qtyReceived: 0, qtyRejected: 1, harga: 40000 }],
    });

    const changed = await fixHutangApprovalIfNeeded(db, hutang, grn);

    expect(changed).toBe(false);
    expect(updates).toHaveLength(0);
  });
});
