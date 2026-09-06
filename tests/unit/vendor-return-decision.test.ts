import { describe, expect, it, vi } from 'vitest';

const writeAuditLog = vi.fn(async () => {});
vi.mock('@/lib/api/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

// Sama seperti so-restock-rejected.test.ts — jalankan "transaksi" tanpa session Mongo asli.
vi.mock('@/lib/api/transaction', () => ({
  runInTransactionOrFallback: async (fn: (ctx: { db: unknown; session?: undefined }) => Promise<unknown>) =>
    fn({ db: (globalThis as { __testDb?: unknown }).__testDb }),
  txOpts: () => ({}),
}));

const postStockMutation = vi.fn(async () => ({ ok: true, qtyAfter: 0, lokasiKode: 'GKERING' }));
vi.mock('@/lib/api/stock-mutation', () => ({
  postStockMutation: (...args: unknown[]) => postStockMutation(...(args as [])),
}));

import { applyVendorReturnDecision } from '@/lib/api/vendor-return-decision';

function makeDb(doc: Record<string, unknown> | null) {
  const state = doc ? { ...doc } : null;
  const db = {
    collection: (name: string) => {
      if (name !== 'vendor_returns') throw new Error(name);
      return {
        findOne: async () => (state ? { ...state, items: [...(state.items as unknown[] || [])] } : null),
        updateOne: async (_f: unknown, u: { $set: Record<string, unknown> }, opts?: { arrayFilters?: Record<string, unknown>[] }) => {
          if (!state) return { modifiedCount: 0 };
          const items = state.items as Record<string, unknown>[];
          for (const [key, value] of Object.entries(u.$set)) {
            const m = key.match(/^items\.\$\[(\w+)\]\.(.+)$/);
            if (m) {
              const [, filterId, field] = m;
              const filter = opts?.arrayFilters?.find((f) => Object.keys(f)[0].startsWith(filterId));
              const filterKey = filter ? Object.keys(filter)[0] : '';
              const filterVal = filter ? filter[filterKey] : undefined;
              const lineIdField = filterKey.split('.')[1];
              for (const it of items) {
                if (it[lineIdField] === filterVal) it[field] = value;
              }
            } else {
              state[key] = value;
            }
          }
          return { modifiedCount: 1 };
        },
      };
    },
  };
  (globalThis as { __testDb?: unknown }).__testDb = db;
  return db as never;
}

const baseDoc = {
  id: 'rtv-1',
  tenantId: 'sppg',
  noReturn: 'RTV1',
  status: 'POSTED',
  creditNoteId: 'cn-1',
  vendorDecision: 'PENDING',
  items: [
    {
      invoiceLineId: 'l1', vendorDecision: 'PENDING',
      localStokId: 'p1', localKode: 'B1', gudangKode: 'GKERING',
      qty: 5, qtyBase: 5, harga: 1000, uomId: 'u1', satuan: 'KG',
    },
    {
      invoiceLineId: 'l2', vendorDecision: 'PENDING',
      localStokId: 'p2', localKode: 'B2', gudangKode: 'GBASAH',
      qty: 3, qtyBase: 3, harga: 2000, uomId: 'u2', satuan: 'PCS',
    },
  ],
};

describe('applyVendorReturnDecision (ADR-006)', () => {
  it('404 kalau RTV tidak ditemukan', async () => {
    const db = makeDb(null);
    const r = await applyVendorReturnDecision(db, 'sppg', {
      returnId: 'rtv-x',
      lineDecisions: [{ lineId: 'l1', decision: 'ACCEPTED' }],
    });
    expect('error' in r && r.status).toBe(404);
  });

  it('409 kalau creditNoteId tidak cocok', async () => {
    const db = makeDb(baseDoc);
    const r = await applyVendorReturnDecision(db, 'sppg', {
      returnId: 'rtv-1',
      creditNoteId: 'cn-lain',
      lineDecisions: [{ lineId: 'l1', decision: 'ACCEPTED' }],
    });
    expect('error' in r && r.status).toBe(409);
  });

  it('400 kalau RTV belum POSTED', async () => {
    const db = makeDb({ ...baseDoc, status: 'DRAFT' });
    const r = await applyVendorReturnDecision(db, 'sppg', {
      returnId: 'rtv-1',
      lineDecisions: [{ lineId: 'l1', decision: 'ACCEPTED' }],
    });
    expect('error' in r && r.status).toBe(400);
  });

  it('400 kalau tidak ada satupun lineId yang cocok (bukan replay sah)', async () => {
    const db = makeDb(baseDoc);
    const r = await applyVendorReturnDecision(db, 'sppg', {
      returnId: 'rtv-1',
      lineDecisions: [{ lineId: 'l-tidak-ada', decision: 'ACCEPTED' }],
    });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.status).toBe(400);
  });

  it('menerapkan keputusan campuran → agregat PARTIAL, audit log ditulis sekali, stok baris ditolak dikembalikan', async () => {
    postStockMutation.mockClear();
    const db = makeDb(baseDoc);
    const r = await applyVendorReturnDecision(db, 'sppg', {
      returnId: 'rtv-1',
      creditNoteId: 'cn-1',
      lineDecisions: [
        { lineId: 'l1', decision: 'ACCEPTED' },
        { lineId: 'l2', decision: 'REJECTED', reason: 'Barang rusak' },
      ],
      decidedBy: { userId: 'u1', userName: 'Vendor' },
    });
    expect('action' in r && r.action).toBe('applied');
    expect('vendorDecision' in r && r.vendorDecision).toBe('PARTIAL');
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][1]).toMatchObject({
      action: 'VENDOR_RETURN_DECISION_APPLIED',
      entityId: 'rtv-1',
    });
    // Hanya l2 (ditolak) yang stoknya dikembalikan — l1 (diterima) tidak disentuh.
    expect(postStockMutation).toHaveBeenCalledTimes(1);
    expect(postStockMutation.mock.calls[0][1]).toMatchObject({
      productId: 'p2',
      warehouseKode: 'GBASAH',
      deltaQtyBase: 3,
      sourceType: 'VENDOR_RETURN_REJECTED',
    });
  });

  it('semua ACCEPTED → agregat ACCEPTED, tidak ada reversal stok sama sekali', async () => {
    postStockMutation.mockClear();
    const db = makeDb(baseDoc);
    const r = await applyVendorReturnDecision(db, 'sppg', {
      returnId: 'rtv-1',
      lineDecisions: [
        { lineId: 'l1', decision: 'ACCEPTED' },
        { lineId: 'l2', decision: 'ACCEPTED' },
      ],
    });
    expect('vendorDecision' in r && r.vendorDecision).toBe('ACCEPTED');
    expect(postStockMutation).not.toHaveBeenCalled();
  });

  it('semua REJECTED → agregat REJECTED, stok kedua baris dikembalikan (D5 fisik, bukan cuma qty-returnable)', async () => {
    postStockMutation.mockClear();
    const db = makeDb(baseDoc);
    const r = await applyVendorReturnDecision(db, 'sppg', {
      returnId: 'rtv-1',
      lineDecisions: [
        { lineId: 'l1', decision: 'REJECTED', reason: 'Salah kirim' },
        { lineId: 'l2', decision: 'REJECTED', reason: 'Salah kirim' },
      ],
    });
    expect('vendorDecision' in r && r.vendorDecision).toBe('REJECTED');
    expect(postStockMutation).toHaveBeenCalledTimes(2);
  });

  it('replay persis sama → already_applied, TIDAK ada audit log kedua (idempotent)', async () => {
    writeAuditLog.mockClear();
    const decided = {
      ...baseDoc,
      vendorDecision: 'PARTIAL',
      items: [
        { invoiceLineId: 'l1', vendorDecision: 'ACCEPTED' },
        { invoiceLineId: 'l2', vendorDecision: 'REJECTED', vendorDecisionReason: 'Barang rusak' },
      ],
    };
    const db = makeDb(decided);
    const r = await applyVendorReturnDecision(db, 'sppg', {
      returnId: 'rtv-1',
      lineDecisions: [
        { lineId: 'l1', decision: 'ACCEPTED' },
        { lineId: 'l2', decision: 'REJECTED', reason: 'Barang rusak' },
      ],
    });
    expect('action' in r && r.action).toBe('already_applied');
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it('replay sebagian (1 baris baru, 1 baris sudah sama) → tetap applied, hanya baris baru yang berubah', async () => {
    writeAuditLog.mockClear();
    const partiallyDecided = {
      ...baseDoc,
      vendorDecision: 'PARTIAL',
      items: [
        { invoiceLineId: 'l1', vendorDecision: 'ACCEPTED' },
        { invoiceLineId: 'l2', vendorDecision: 'PENDING' },
      ],
    };
    const db = makeDb(partiallyDecided);
    const r = await applyVendorReturnDecision(db, 'sppg', {
      returnId: 'rtv-1',
      lineDecisions: [
        { lineId: 'l1', decision: 'ACCEPTED' },
        { lineId: 'l2', decision: 'REJECTED', reason: 'Baru ditolak' },
      ],
    });
    expect('action' in r && r.action).toBe('applied');
    expect('vendorDecision' in r && r.vendorDecision).toBe('PARTIAL');
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });
});
