import { describe, expect, it, vi } from 'vitest';

/** ADR-006 — konvergensi CN→RTV hanya full-accept (semua lineId RTV di payload.items).
 * Partial CN jangan stamp — biarkan Category B decision push. */

vi.mock('@/lib/api/transaction', () => ({
  runInTransactionOrFallback: async (fn: (ctx: { db: unknown; session?: unknown }) => unknown) =>
    fn({ db: (globalThis as never as { __testDb: unknown }).__testDb, session: undefined }),
  txOpts: () => ({}),
}));
vi.mock('@/lib/api/journal', () => ({
  createJournalIfNotExists: async () => null,
  createJournal: async () => null,
}));
vi.mock('@/lib/api/audit-log', () => ({
  writeAuditLog: async () => {},
}));

import { applyCreditNoteFromVendor, maybeStampVendorReturnFullAcceptFromCn } from '@/lib/api/hutang-from-vendor';

function makeDb(
  hutang: Record<string, unknown>,
  opts?: {
    vendorReturnsUpdateOne?: ReturnType<typeof vi.fn>;
    rtv?: Record<string, unknown> | null;
  },
) {
  const vendorReturnsUpdateOne = opts?.vendorReturnsUpdateOne || vi.fn(async () => ({ matchedCount: 1 }));
  const rtv = opts?.rtv === undefined
    ? {
      id: 'rtv-1',
      items: [
        { invoiceLineId: 'l1' },
        { invoiceLineId: 'l2' },
      ],
    }
    : opts.rtv;
  const db = {
    collection: (name: string) => {
      if (name === 'hutang') {
        return {
          findOne: async () => hutang,
          updateOne: async () => ({ matchedCount: 1 }),
        };
      }
      if (name === 'vendor_returns') {
        return {
          findOne: async () => rtv,
          updateOne: vendorReturnsUpdateOne,
        };
      }
      throw new Error(`unexpected collection: ${name}`);
    },
  };
  (globalThis as never as { __testDb: unknown }).__testDb = db;
  return { db: db as never, vendorReturnsUpdateOne };
}

const baseHutang = {
  id: 'h1',
  vendorInvoiceId: 'inv-1',
  sisa: 1000,
  total: 1000,
  terbayar: 0,
  status: 'APPROVED',
  approvalStatus: 'APPROVED',
  creditNotes: [],
};

describe('maybeStampVendorReturnFullAcceptFromCn', () => {
  it('full accept (semua lineId RTV di items) → stamp ACCEPTED', async () => {
    const { db, vendorReturnsUpdateOne } = makeDb(baseHutang);
    const r = await maybeStampVendorReturnFullAcceptFromCn(db, 'sppg', 'cn-1', {
      items: [{ lineId: 'l1' }, { lineId: 'l2' }],
    });
    expect(r).toEqual({ stamped: true, reason: 'full_accept' });
    expect(vendorReturnsUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('partial CN (subset lineId) → skip stamp', async () => {
    const { db, vendorReturnsUpdateOne } = makeDb(baseHutang);
    const r = await maybeStampVendorReturnFullAcceptFromCn(db, 'sppg', 'cn-1', {
      items: [{ lineId: 'l1' }],
    });
    expect(r).toEqual({ stamped: false, reason: 'partial_cn_skip' });
    expect(vendorReturnsUpdateOne).not.toHaveBeenCalled();
  });

  it('tanpa lineId di items → skip (race-safe)', async () => {
    const { db, vendorReturnsUpdateOne } = makeDb(baseHutang);
    const r = await maybeStampVendorReturnFullAcceptFromCn(db, 'sppg', 'cn-1', { items: [] });
    expect(r.stamped).toBe(false);
    expect(r.reason).toBe('no_accepted_line_ids');
    expect(vendorReturnsUpdateOne).not.toHaveBeenCalled();
  });
});

describe('applyCreditNoteFromVendor — konvergensi vendorDecision (ADR-006)', () => {
  it('inventory_return full-accept items → stamp RTV ACCEPTED', async () => {
    const { db, vendorReturnsUpdateOne } = makeDb({ ...baseHutang });

    const r = await applyCreditNoteFromVendor(
      db,
      'sppg',
      {
        invoiceId: 'inv-1',
        total: 100,
        creditNoteId: 'cn-legacy-1',
        noCN: 'CN1',
        source: 'inventory_return',
        noReturn: 'RTV1',
        items: [{ lineId: 'l1' }, { lineId: 'l2' }] as never,
      },
      'vendor-a',
    );

    expect(r).toMatchObject({ action: 'credit_applied', hutangId: 'h1' });
    expect(vendorReturnsUpdateOne).toHaveBeenCalledTimes(1);
    const [, update] = vendorReturnsUpdateOne.mock.calls[0];
    expect(update.$set).toMatchObject({
      vendorDecision: 'ACCEPTED',
      'items.$[].vendorDecision': 'ACCEPTED',
    });
  });

  it('inventory_return partial items → TIDAK stamp RTV (hindari race PARTIAL)', async () => {
    const { db, vendorReturnsUpdateOne } = makeDb({ ...baseHutang });

    const r = await applyCreditNoteFromVendor(
      db,
      'sppg',
      {
        invoiceId: 'inv-1',
        total: 50,
        creditNoteId: 'cn-partial-1',
        noCN: 'CN-P',
        source: 'inventory_return',
        items: [{ lineId: 'l1' }] as never,
      },
      'vendor-a',
    );

    expect(r).toMatchObject({ action: 'credit_applied' });
    expect(vendorReturnsUpdateOne).not.toHaveBeenCalled();
  });

  it('inventory_return tanpa items → TIDAK stamp', async () => {
    const { db, vendorReturnsUpdateOne } = makeDb({ ...baseHutang });

    const r = await applyCreditNoteFromVendor(
      db,
      'sppg',
      {
        invoiceId: 'inv-1',
        total: 100,
        creditNoteId: 'cn-no-items',
        source: 'inventory_return',
      },
      'vendor-a',
    );

    expect(r).toMatchObject({ action: 'credit_applied' });
    expect(vendorReturnsUpdateOne).not.toHaveBeenCalled();
  });

  it('source manual: TIDAK menyentuh vendor_returns', async () => {
    const { db, vendorReturnsUpdateOne } = makeDb({ ...baseHutang });

    const r = await applyCreditNoteFromVendor(
      db,
      'sppg',
      { invoiceId: 'inv-1', total: 100, creditNoteId: 'cn-manual-1', noCN: 'CN2' },
      'vendor-a',
    );

    expect(r).toMatchObject({ action: 'credit_applied', hutangId: 'h1' });
    expect(vendorReturnsUpdateOne).not.toHaveBeenCalled();
  });
});
