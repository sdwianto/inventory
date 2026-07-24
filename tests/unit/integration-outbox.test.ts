import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_OUTBOX_TYPES,
  applyGrnInvoiceNotifyResult,
  claimEnsureGrnInvoiceOutbox,
  insertEnsureGrnInvoiceOutbox,
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
});
