import { describe, expect, it, vi } from 'vitest';
import { applyCreditNoteFromVendor } from '@/lib/api/hutang-from-vendor';

describe('applyCreditNoteFromVendor', () => {
  it('creditNoteId yang sama → already_applied, tidak mengurangi sisa lagi', async () => {
    const hutang = {
      id: 'h1',
      vendorInvoiceId: 'inv-1',
      sisa: 900,
      total: 1000,
      terbayar: 100,
      creditNotes: [{ creditNoteId: 'cn-1', amount: 100 }],
    };
    const updateOne = vi.fn();
    const db = {
      collection: () => ({
        findOne: async () => hutang,
        updateOne,
      }),
    };
    const first = await applyCreditNoteFromVendor(
      db as never,
      'sppg',
      { invoiceId: 'inv-1', total: 100, creditNoteId: 'cn-1', noCN: 'CN1' },
      'vendor-a',
    );
    const second = await applyCreditNoteFromVendor(
      db as never,
      'sppg',
      { invoiceId: 'inv-1', total: 100, creditNoteId: 'cn-1', noCN: 'CN1' },
      'vendor-a',
    );
    expect(first).toEqual({ action: 'already_applied', hutangId: 'h1' });
    expect(second).toEqual({ action: 'already_applied', hutangId: 'h1' });
    expect(updateOne).not.toHaveBeenCalled();
  });
});
