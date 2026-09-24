/**
 * Fase 0.2 — CAS, nomor dokumen & audit di dalam transaksi, terhadap MongoDB replica set sungguhan.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang (mis. image build produksi).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { CasConflictError, casEditFilter, casUpdateWithAudit, insertWithAudit } from '@/lib/api/cas';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { runInTransactionOnDb } from '@/lib/api/transaction';
import { relocateLotsFefo } from '@/lib/stock-ledger/lot-relocate';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-cas';

describe.skipIf(!MongoMemoryReplSet)('Fase 0.2 CAS + transaksi (Mongo replica set)', { timeout: 60_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('cas_it');
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  beforeEach(async () => {
    for (const c of ['docs', 'audit_log', 'document_sequences', 'ingredient_lots']) {
      await db.collection(c).deleteMany({});
    }
  });

  const seq = async () => (await db.collection('document_sequences').findOne({ tenantId: TID, docType: 'T' }))?.lastNumber ?? 0;
  const audits = () => db.collection('audit_log').countDocuments({ tenantId: TID });

  it('insertWithAudit: nomor dokumen, insert, dan audit satu commit', async () => {
    const doc = { id: 'd1', tenantId: TID, no: '', status: 'DRAFT' };
    await insertWithAudit({
      db,
      collection: 'docs',
      doc,
      before: async ({ db: txDb, session }) => {
        doc.no = await nextDocNumber(txDb, TID, 'T', 'T', session);
      },
      audit: () => ({ tenantId: TID, action: 'PR_CREATE', entityType: 'doc', entityId: doc.id, summary: `dibuat ${doc.no}` }),
    });
    const saved = await db.collection('docs').findOne({ id: 'd1' });
    expect(saved?.no).toMatch(/^T/);
    expect(await seq()).toBe(1);
    const audit = await db.collection('audit_log').findOne({ entityId: 'd1' });
    expect(audit?.summary).toBe(`dibuat ${saved?.no}`);
  });

  it('insertWithAudit: gagal setelah ambil nomor → nomor, dokumen, dan audit ikut rollback', async () => {
    const doc = { id: 'd2', tenantId: TID, no: '' };
    await expect(insertWithAudit({
      db,
      collection: 'docs',
      doc,
      before: async ({ db: txDb, session }) => {
        doc.no = await nextDocNumber(txDb, TID, 'T', 'T', session);
        throw new CasConflictError();
      },
      audit: { tenantId: TID, action: 'PR_CREATE', entityType: 'doc', entityId: 'd2', summary: 'x' },
    })).rejects.toBeInstanceOf(CasConflictError);
    expect(await db.collection('docs').countDocuments({ id: 'd2' })).toBe(0);
    expect(await seq()).toBe(0);
    expect(await audits()).toBe(0);
  });

  it('casUpdateWithAudit: dokumen basi → 409 tanpa perubahan dan tanpa audit', async () => {
    await db.collection('docs').insertOne({ id: 'd3', tenantId: TID, status: 'DRAFT', updatedAt: new Date('2026-01-01') });
    const stale = { id: 'd3', status: 'DRAFT', updatedAt: new Date('2025-12-31') };
    const res = await casUpdateWithAudit({
      db,
      collection: 'docs',
      filter: casEditFilter(stale),
      update: { $set: { status: 'APPROVED' } },
      audit: { tenantId: TID, action: 'PR_STATUS', entityType: 'doc', entityId: 'd3', summary: 'x' },
    });
    expect(res?.status).toBe(409);
    expect((await db.collection('docs').findOne({ id: 'd3' }))?.status).toBe('DRAFT');
    expect(await audits()).toBe(0);
  });

  it('casUpdateWithAudit: konflik di `before` me-rollback tulisan sebelumnya', async () => {
    await db.collection('docs').insertOne({ id: 'd4', tenantId: TID, status: 'DRAFT', updatedAt: null });
    const fresh = await db.collection('docs').findOne({ id: 'd4' });
    const res = await casUpdateWithAudit({
      db,
      collection: 'docs',
      filter: casEditFilter(fresh!),
      update: { $set: { status: 'APPROVED' } },
      before: async ({ db: txDb, session }) => {
        await nextDocNumber(txDb, TID, 'T', 'T', session);
        throw new CasConflictError('alokasi melebihi sumber');
      },
      audit: { tenantId: TID, action: 'PR_STATUS', entityType: 'doc', entityId: 'd4', summary: 'x' },
    });
    expect(res?.status).toBe(409);
    expect(await seq()).toBe(0);
    expect((await db.collection('docs').findOne({ id: 'd4' }))?.status).toBe('DRAFT');
  });

  it('casUpdateWithAudit: dua transisi paralel → tepat satu menang', async () => {
    await db.collection('docs').insertOne({ id: 'd5', tenantId: TID, status: 'DRAFT', updatedAt: null });
    const snap = await db.collection('docs').findOne({ id: 'd5' });
    const run = (to: string) => casUpdateWithAudit({
      db,
      collection: 'docs',
      filter: casEditFilter(snap!),
      update: { $set: { status: to, updatedAt: new Date() } },
      audit: { tenantId: TID, action: 'PR_STATUS', entityType: 'doc', entityId: 'd5', summary: to },
    });
    const results = await Promise.all([run('APPROVED'), run('CANCELLED')]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r?.status === 409)).toHaveLength(1);
    expect(await audits()).toBe(1);
  });

  it('relocateLotsFefo paralel pada lot yang sama: qty lot tetap kekal (tanpa lost update)', async () => {
    await db.collection('ingredient_lots').insertOne({
      id: 'lot1', tenantId: TID, lotNo: 'L1', productId: 'gula', warehouseKode: 'GKERING',
      qty: 10, qtyRemaining: 10, status: 'ACTIVE', expiryDate: '2027-01-01', updatedAt: new Date('2026-01-01'),
    });
    const move = () => runInTransactionOnDb(db, ({ db: txDb, session }) => relocateLotsFefo(txDb, {
      tenantId: TID, stokId: 'gula', fromWarehouseKode: 'GKERING', toWarehouseKode: 'GBASAH', needQty: 6,
    }, session));
    const settled = await Promise.allSettled([move(), move()]);
    const lots = await db.collection('ingredient_lots').find({ tenantId: TID }).toArray();
    const total = lots.reduce((s, l) => s + Number(l.qtyRemaining || 0), 0);
    expect(total).toBeCloseTo(10, 6);
    const moved = lots.filter((l) => l.warehouseKode === 'GBASAH').reduce((s, l) => s + Number(l.qtyRemaining || 0), 0);
    const allocated = settled
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof move>>> => r.status === 'fulfilled')
      .reduce((s, r) => s + r.value.allocated, 0);
    expect(moved).toBeCloseTo(allocated, 6);
  });
});
