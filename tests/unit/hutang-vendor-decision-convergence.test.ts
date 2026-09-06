import { describe, expect, it, vi } from 'vitest';

/** ADR-006 — konvergensi legacy peer: `applyCreditNoteFromVendor` menstempel RTV
 * `vendorDecision:'ACCEPTED'` (semua baris) HANYA kalau CN datang dari
 * `source:'inventory_return'` DAN RTV itu masih `vendorDecision:'PENDING'` (belum
 * pernah diputuskan lewat webhook keputusan vendor terpisah). */

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

import { applyCreditNoteFromVendor } from '@/lib/api/hutang-from-vendor';

function makeDb(hutang: Record<string, unknown>, vendorReturnsUpdateOne: ReturnType<typeof vi.fn>) {
  const db = {
    collection: (name: string) => {
      if (name === 'hutang') {
        return {
          findOne: async () => hutang,
          updateOne: async () => ({ matchedCount: 1 }),
        };
      }
      if (name === 'vendor_returns') {
        return { updateOne: vendorReturnsUpdateOne };
      }
      throw new Error(`unexpected collection: ${name}`);
    },
  };
  (globalThis as never as { __testDb: unknown }).__testDb = db;
  return db as never;
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

describe('applyCreditNoteFromVendor — konvergensi vendorDecision (ADR-006)', () => {
  it('source inventory_return: menstempel vendor_returns jadi ACCEPTED (semua baris) hanya kalau masih PENDING', async () => {
    const vendorReturnsUpdateOne = vi.fn(async () => ({ matchedCount: 1 }));
    const db = makeDb({ ...baseHutang }, vendorReturnsUpdateOne);

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
      },
      'vendor-a',
    );

    expect(r).toMatchObject({ action: 'credit_applied', hutangId: 'h1' });
    expect(vendorReturnsUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = vendorReturnsUpdateOne.mock.calls[0];
    expect(filter).toMatchObject({ tenantId: 'sppg', creditNoteId: 'cn-legacy-1', vendorDecision: 'PENDING' });
    expect(update.$set).toMatchObject({
      vendorDecision: 'ACCEPTED',
      'items.$[].vendorDecision': 'ACCEPTED',
    });
    expect(update.$set.vendorDecisionAt).toBeInstanceOf(Date);
  });

  it('source manual (bukan inventory_return): TIDAK menyentuh vendor_returns sama sekali', async () => {
    const vendorReturnsUpdateOne = vi.fn(async () => ({ matchedCount: 1 }));
    const db = makeDb({ ...baseHutang }, vendorReturnsUpdateOne);

    const r = await applyCreditNoteFromVendor(
      db,
      'sppg',
      { invoiceId: 'inv-1', total: 100, creditNoteId: 'cn-manual-1', noCN: 'CN2' },
      'vendor-a',
    );

    expect(r).toMatchObject({ action: 'credit_applied', hutangId: 'h1' });
    expect(vendorReturnsUpdateOne).not.toHaveBeenCalled();
  });

  it('inventory_return TANPA creditNoteId: tidak ada filter vendorDecision:PENDING untuk dicocokkan, jadi tidak menyentuh vendor_returns', async () => {
    const vendorReturnsUpdateOne = vi.fn(async () => ({ matchedCount: 1 }));
    const db = makeDb({ ...baseHutang }, vendorReturnsUpdateOne);

    const r = await applyCreditNoteFromVendor(
      db,
      'sppg',
      { invoiceId: 'inv-1', total: 100, source: 'inventory_return', noReturn: 'RTV2' },
      'vendor-a',
    );

    expect(r).toMatchObject({ action: 'credit_applied', hutangId: 'h1' });
    expect(vendorReturnsUpdateOne).not.toHaveBeenCalled();
  });
});
