import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_OUTBOX_TYPES,
  applyGrnInvoiceNotifyResult,
  claimEnsureGrnInvoiceOutbox,
  insertEnsureGrnInvoiceOutbox,
  insertEnsureGoodsReturnCnOutbox,
} from '@/lib/api/integration-outbox';

function memoryCollection() {
  const docs: Record<string, unknown>[] = [];
  return {
    docs,
    async insertOne(doc: Record<string, unknown>) {
      const dup = docs.find(
        (d) => d.type === doc.type && d.aggregateId === doc.aggregateId,
      );
      if (dup) {
        const err = new Error('E11000 duplicate') as Error & { code: number };
        err.code = 11000;
        throw err;
      }
      docs.push({ ...doc });
      return { insertedId: doc.id };
    },
    async findOne(filter: Record<string, unknown>) {
      return (
        docs.find((d) => {
          if (filter.type != null && d.type !== filter.type) return false;
          if (filter.aggregateId != null && d.aggregateId !== filter.aggregateId) return false;
          if (filter.id != null && d.id !== filter.id) return false;
          return true;
        }) || null
      );
    },
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown>; $inc?: Record<string, number> },
    ) {
      const or = filter.$or as Array<Record<string, unknown>> | undefined;
      const idx = docs.findIndex((d) => {
        if (d.type !== filter.type || d.aggregateId !== filter.aggregateId) return false;
        if (!or) return true;
        return or.some((clause) => {
          if (clause.status && d.status !== clause.status) return false;
          if (clause.updatedAt && typeof clause.updatedAt === 'object') {
            const lt = (clause.updatedAt as { $lt?: Date }).$lt;
            if (lt && !(d.updatedAt instanceof Date && d.updatedAt < lt)) return false;
          }
          return true;
        });
      });
      if (idx < 0) return null;
      const next = { ...docs[idx], ...(update.$set || {}) };
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          next[k] = Number(next[k] || 0) + v;
        }
      }
      docs[idx] = next;
      return next;
    },
    async updateOne(filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) {
      const idx = docs.findIndex((d) => d.id === filter.id);
      if (idx < 0) return { modifiedCount: 0 };
      docs[idx] = { ...docs[idx], ...(update.$set || {}) };
      return { modifiedCount: 1 };
    },
  };
}

describe('integration-outbox H1.1', () => {
  it('inserts ENSURE_GRN_INVOICE once per aggregate (dedupe)', async () => {
    const col = memoryCollection();
    const db = { collection: () => col } as never;
    const a = await insertEnsureGrnInvoiceOutbox(db, {
      tenantId: 'sppg',
      grnId: 'grn-1',
      noGRN: 'GRN-1',
    });
    const b = await insertEnsureGrnInvoiceOutbox(db, {
      tenantId: 'sppg',
      grnId: 'grn-1',
      noGRN: 'GRN-1',
    });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(col.docs).toHaveLength(1);
    expect(col.docs[0].type).toBe(INTEGRATION_OUTBOX_TYPES.ENSURE_GRN_INVOICE);
    expect(col.docs[0].status).toBe('PENDING');
  });

  it('claims PENDING then not again until DONE/FAILED reopen', async () => {
    const col = memoryCollection();
    const db = { collection: () => col } as never;
    await insertEnsureGrnInvoiceOutbox(db, { tenantId: 'sppg', grnId: 'grn-2' });
    const c1 = await claimEnsureGrnInvoiceOutbox(db, 'grn-2');
    expect(c1?.status).toBe('PROCESSING');
    expect(c1?.attempts).toBe(1);
    const c2 = await claimEnsureGrnInvoiceOutbox(db, 'grn-2');
    expect(c2).toBeNull();
  });

  it('exports ENSURE_CREATE_SO for H1.3 (Sales Order, not Supplier Order)', async () => {
    const { INTEGRATION_OUTBOX_TYPES: types, insertEnsureCreateSoOutbox } = await import(
      '@/lib/api/integration-outbox'
    );
    expect(types.ENSURE_CREATE_SO).toBe('ENSURE_CREATE_SO');
    const col = memoryCollection();
    const db = { collection: () => col } as never;
    const a = await insertEnsureCreateSoOutbox(db, {
      tenantId: 'sppg',
      poId: 'po-1',
      noPO: 'PO-1',
    });
    expect(a.inserted).toBe(true);
    expect(col.docs[0].type).toBe('ENSURE_CREATE_SO');
  });

  it('exports ENSURE_PUSH_CANCEL_SO and inserts once per poId (W1-2)', async () => {
    const {
      INTEGRATION_OUTBOX_TYPES: types,
      insertEnsurePushCancelSoOutbox,
    } = await import('@/lib/api/integration-outbox');
    expect(types.ENSURE_PUSH_CANCEL_SO).toBe('ENSURE_PUSH_CANCEL_SO');
    const col = memoryCollection();
    const db = { collection: () => col } as never;
    const a = await insertEnsurePushCancelSoOutbox(db, {
      tenantId: 'sppg',
      poId: 'po-cancel-1',
      noPO: 'PO-C1',
      reason: 'test',
    });
    const b = await insertEnsurePushCancelSoOutbox(db, {
      tenantId: 'sppg',
      poId: 'po-cancel-1',
      reason: 'test',
    });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(col.docs).toHaveLength(1);
    expect(col.docs[0].type).toBe('ENSURE_PUSH_CANCEL_SO');
  });

  it('applyGrnInvoiceNotifyResult marks FAILED without invoice', async () => {
    const grns: Record<string, unknown>[] = [{ id: 'g1' }];
    const db = {
      collection: (name: string) => {
        if (name !== 'goods_receipts') throw new Error(name);
        return {
          updateOne: async (_f: unknown, u: { $set: Record<string, unknown> }) => {
            Object.assign(grns[0], u.$set);
            return { modifiedCount: 1 };
          },
        };
      },
    } as never;
    const r = await applyGrnInvoiceNotifyResult(db, 'g1', { error: 'timeout' });
    expect(r.invoiceSyncStatus).toBe('FAILED');
    expect(r.needsRecovery).toBe(true);
    expect(grns[0].invoiceSyncStatus).toBe('FAILED');
  });

  it('inserts ENSURE_GOODS_RETURN_CN once per RTV (dedupe)', async () => {
    const col = memoryCollection();
    const db = { collection: () => col } as never;
    const a = await insertEnsureGoodsReturnCnOutbox(db, {
      tenantId: 'sppg',
      returnId: 'rtv-1',
      noReturn: 'RTV-1',
    });
    const b = await insertEnsureGoodsReturnCnOutbox(db, {
      tenantId: 'sppg',
      returnId: 'rtv-1',
      noReturn: 'RTV-1',
    });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(col.docs).toHaveLength(1);
    expect(col.docs[0].type).toBe(INTEGRATION_OUTBOX_TYPES.ENSURE_GOODS_RETURN_CN);
    expect(INTEGRATION_OUTBOX_TYPES.ENSURE_GOODS_RETURN_CN).toBe('ENSURE_GOODS_RETURN_CN');
  });

  it('applyVendorReturnCnNotifyResult DONE hanya jika Sales CN sukses', async () => {
    const { applyVendorReturnCnNotifyResult } = await import('@/lib/api/integration-outbox');
    const docs: Record<string, unknown>[] = [{ id: 'rtv-1', items: [{ invoiceLineId: 'l1' }] }];
    const db = {
      collection: (name: string) => {
        if (name !== 'vendor_returns') throw new Error(name);
        return {
          findOne: async () => docs[0],
          updateOne: async (_f: unknown, u: { $set: Record<string, unknown> }) => {
            Object.assign(docs[0], u.$set);
            return { modifiedCount: 1 };
          },
        };
      },
    } as never;

    const failed = await applyVendorReturnCnNotifyResult(db, 'rtv-1', {
      ok: false,
      error: 'timeout',
      creditNoteId: 'cn-draft',
    });
    expect(failed.cnSyncStatus).toBe('FAILED');
    expect(failed.needsRecovery).toBe(true);
    expect(docs[0].cnSyncStatus).toBe('FAILED');

    const done = await applyVendorReturnCnNotifyResult(db, 'rtv-1', {
      ok: true,
      creditNoteId: 'cn-1',
      noCN: 'CN1',
    });
    expect(done.cnSyncStatus).toBe('DONE');
    expect(docs[0].creditNoteId).toBe('cn-1');
    // ADR-006: peer lama (tanpa pendingDecision) → semua baris otomatis ACCEPTED.
    expect(docs[0].vendorDecision).toBe('ACCEPTED');
    expect((docs[0].items as Array<{ vendorDecision?: string }>)[0].vendorDecision).toBe('ACCEPTED');
  });

  it('applyVendorReturnCnNotifyResult stempel PENDING kalau Sales CN masih menunggu keputusan vendor (ADR-006)', async () => {
    const { applyVendorReturnCnNotifyResult } = await import('@/lib/api/integration-outbox');
    const docs: Record<string, unknown>[] = [{ id: 'rtv-2', items: [{ invoiceLineId: 'l1' }, { invoiceLineId: 'l2' }] }];
    const db = {
      collection: (name: string) => {
        if (name !== 'vendor_returns') throw new Error(name);
        return {
          findOne: async () => docs[0],
          updateOne: async (_f: unknown, u: { $set: Record<string, unknown> }) => {
            Object.assign(docs[0], u.$set);
            return { modifiedCount: 1 };
          },
        };
      },
    } as never;

    const result = await applyVendorReturnCnNotifyResult(db, 'rtv-2', {
      ok: true,
      creditNoteId: 'cn-draft',
      noCN: 'CN-D',
      pendingDecision: true,
    });
    expect(result.cnSyncStatus).toBe('DONE');
    expect(docs[0].vendorDecision).toBe('PENDING');
    expect(docs[0].vendorDecisionAt).toBeUndefined();
    const items = docs[0].items as Array<{ vendorDecision?: string }>;
    expect(items.every((it) => it.vendorDecision === 'PENDING')).toBe(true);
  });

  it('applyVendorReturnCnNotifyResult TIDAK menimpa keputusan vendor yang sudah nyata (ADR-006 regression)', async () => {
    // Simulasi retry/recovery drain yang terlambat: notify Sales POSTED lagi (replay),
    // tapi vendor SUDAH memutuskan PARTIAL lewat webhook terpisah sebelum retry ini jalan.
    // Ini TIDAK boleh menimpa baris yang sudah REJECTED kembali jadi ACCEPTED.
    const { applyVendorReturnCnNotifyResult } = await import('@/lib/api/integration-outbox');
    const docs: Record<string, unknown>[] = [{
      id: 'rtv-3',
      vendorDecision: 'PARTIAL',
      items: [
        { invoiceLineId: 'l1', vendorDecision: 'ACCEPTED' },
        { invoiceLineId: 'l2', vendorDecision: 'REJECTED', vendorDecisionReason: 'Barang rusak' },
      ],
    }];
    const db = {
      collection: (name: string) => {
        if (name !== 'vendor_returns') throw new Error(name);
        return {
          findOne: async () => docs[0],
          updateOne: async (_f: unknown, u: { $set: Record<string, unknown> }) => {
            Object.assign(docs[0], u.$set);
            return { modifiedCount: 1 };
          },
        };
      },
    } as never;

    const result = await applyVendorReturnCnNotifyResult(db, 'rtv-3', {
      ok: true,
      creditNoteId: 'cn-1',
      noCN: 'CN1',
      // Tidak ada pendingDecision — bentuk respons yang sama seperti replay "sudah POSTED".
    });
    expect(result.cnSyncStatus).toBe('DONE');
    // vendorDecision agregat & per-baris TIDAK berubah — bukti tidak ada clobbering.
    expect(docs[0].vendorDecision).toBe('PARTIAL');
    const items = docs[0].items as Array<{ invoiceLineId: string; vendorDecision?: string; vendorDecisionReason?: string }>;
    expect(items.find((it) => it.invoiceLineId === 'l2')?.vendorDecision).toBe('REJECTED');
    expect(items.find((it) => it.invoiceLineId === 'l2')?.vendorDecisionReason).toBe('Barang rusak');
  });
});
