import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/transaction', () => ({
  runInTransactionOrFallback: async (fn: (ctx: { db: unknown; session?: unknown }) => unknown) =>
    fn({ db: (globalThis as never as { __testDb: unknown }).__testDb, session: undefined }),
  txOpts: () => ({}),
}));

const createJournalIfNotExists = vi.fn(async (_db: unknown, params: { details?: unknown[] }) => ({
  id: 'j-cn',
  details: params.details,
}));
vi.mock('@/lib/api/journal', () => ({
  createJournalIfNotExists: (...args: unknown[]) => createJournalIfNotExists(...(args as never[])),
  createJournal: async () => null,
}));
vi.mock('@/lib/api/audit-log', () => ({ writeAuditLog: async () => {} }));

import { applyCreditNoteFromVendor } from '@/lib/api/hutang-from-vendor';

describe('applyCreditNoteFromVendor — clearTransit race-safe', () => {
  beforeEach(() => {
    createJournalIfNotExists.mockClear();
  });

  function makeDb(opts: {
    hutang: Record<string, unknown>;
    rtv: Record<string, unknown> | null;
  }) {
    const db = {
      collection: (name: string) => {
        if (name === 'hutang') {
          return {
            findOne: async () => opts.hutang,
            updateOne: async () => ({ matchedCount: 1 }),
          };
        }
        if (name === 'vendor_returns') {
          return {
            findOne: async (filter: Record<string, unknown>) => {
              // Simulate RTV belum punya creditNoteId — hanya cocok via noReturn / id.
              if (!opts.rtv) return null;
              const or = filter.$or as Array<Record<string, unknown>> | undefined;
              if (or?.some((c) => c.noReturn === opts.rtv?.noReturn || c.id === opts.rtv?.id)) {
                return opts.rtv;
              }
              if (filter.creditNoteId && filter.creditNoteId === opts.rtv.creditNoteId) {
                return opts.rtv;
              }
              return null;
            },
            updateOne: async () => ({ matchedCount: 1 }),
          };
        }
        throw new Error(name);
      },
    };
    (globalThis as never as { __testDb: unknown }).__testDb = db;
    return db as never;
  }

  const hutang = {
    id: 'h1',
    vendorInvoiceId: 'inv-1',
    sisa: 111000,
    total: 111000,
    ppn: 11000,
    terbayar: 0,
    status: 'APPROVED',
    approvalStatus: 'APPROVED',
    creditNotes: [],
  };

  it('clearTransit via noReturn meski RTV belum punya creditNoteId', async () => {
    const db = makeDb({
      hutang: { ...hutang, creditNotes: [] },
      rtv: {
        id: 'rtv-1',
        noReturn: 'RTV1',
        transitAppliedAt: new Date(),
        transitJournalId: 'j-out',
        // creditNoteId sengaja kosong — race Category A
      },
    });

    await applyCreditNoteFromVendor(
      db,
      'sppg',
      {
        invoiceId: 'inv-1',
        total: 55500,
        creditNoteId: 'cn-new',
        noCN: 'CN1',
        source: 'inventory_return',
        noReturn: 'RTV1',
      },
      'vendor-a',
    );

    expect(createJournalIfNotExists).toHaveBeenCalled();
    const details = createJournalIfNotExists.mock.calls[0][1].details as Array<{
      rekeningKode: string;
      kredit: number;
    }>;
    expect(details.find((d) => d.rekeningKode === '10315')?.kredit).toBe(50000);
    expect(details.find((d) => d.rekeningKode === '10310')).toBeUndefined();
  });

  it('opts.clearTransit=true tanpa lookup', async () => {
    const db = makeDb({
      hutang: { ...hutang, creditNotes: [] },
      rtv: null,
    });

    await applyCreditNoteFromVendor(
      db,
      'sppg',
      {
        invoiceId: 'inv-1',
        total: 50000,
        creditNoteId: 'cn-2',
        source: 'inventory_return',
        noReturn: 'RTV-X',
      },
      'vendor-a',
      { clearTransit: true, returnId: 'rtv-x' },
    );

    const details = createJournalIfNotExists.mock.calls[0][1].details as Array<{
      rekeningKode: string;
    }>;
    expect(details.some((d) => d.rekeningKode === '10315')).toBe(true);
  });

  it('tanpa transit flag → Cr Persediaan (legacy)', async () => {
    const db = makeDb({
      hutang: { ...hutang, creditNotes: [] },
      rtv: { id: 'rtv-old', noReturn: 'RTV-OLD' },
    });

    await applyCreditNoteFromVendor(
      db,
      'sppg',
      {
        invoiceId: 'inv-1',
        total: 50000,
        creditNoteId: 'cn-3',
        noReturn: 'RTV-OLD',
      },
      'vendor-a',
    );

    const details = createJournalIfNotExists.mock.calls[0][1].details as Array<{
      rekeningKode: string;
    }>;
    expect(details.some((d) => d.rekeningKode === '10310')).toBe(true);
    expect(details.some((d) => d.rekeningKode === '10315')).toBe(false);
  });
});
