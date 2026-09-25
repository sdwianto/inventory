/**
 * Fase 3.5 — 3-way match per baris (PO/SO, GRN, invoice, retur) dan siklus jurnal
 * AUTO_HUTANG_VENDOR (EXCEPTION tanpa GL sampai disetujui).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';

vi.mock('@/lib/api/transaction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/transaction')>('@/lib/api/transaction');
  const testDb = () => (globalThis as { __hutang35Db?: Db }).__hutang35Db!;
  return {
    ...actual,
    runInTransactionOrFallback: (fn: Parameters<typeof actual.runInTransactionOrFallback>[0]) => (
      actual.runInTransactionOnDb(testDb(), fn)
    ),
  };
});

import { validateInvoiceAgainstGrn } from '@/lib/api/three-way-match';
import { createHutangFromVendorInvoice } from '@/lib/api/hutang-from-vendor';
import {
  findActiveVendorHutangJournal,
  postOrDeferNoteJournal,
  postVendorHutangJournal,
  voidVendorHutangJournal,
  vendorHutangPostingBase,
} from '@/lib/api/hutang-vendor-journal';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-35';

describe.skipIf(!MongoMemoryReplSet)('Fase 3.5 3-way match + jurnal hutang', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('hutang_35_it');
    (globalThis as { __hutang35Db?: Db }).__hutang35Db = db;
    await db.collection('goods_receipts').insertOne({
      id: 'grn-1', tenantId: TID, noDO: 'DO-1', noPO: 'PO-1', status: 'POSTED',
      items: [{ lineId: 'l1', vendorKode: 'BERAS', satuan: 'KG', qtyReceived: 10, harga: 10000 }],
    });
    await db.collection('customer_purchase_orders').insertOne({
      id: 'po-1', tenantId: TID, noPO: 'PO-1', status: 'RECEIVED',
      items: [{ lineId: 'l1', vendorKode: 'BERAS', satuan: 'KG', qty: 10, estimasiHarga: 9000 }],
      vendorSoSnapshot: { items: [{ kode: 'BERAS', satuan: 'KG', qty: 10, harga: 10000 }] },
    });
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  const invoice = (qty: number, harga = 10000, invoiceId = 'inv-new') => ({
    invoiceId,
    noInvoice: invoiceId.toUpperCase(),
    noDO: 'DO-1',
    noPO: 'PO-1',
    subTotal: qty * harga,
    total: qty * harga,
    items: [{ lineId: 'l1', kode: 'BERAS', satuan: 'KG', qty, harga }],
  });

  it('harga SO vendor jadi acuan harga PO; estimasi PO tidak dipakai', async () => {
    expect((await validateInvoiceAgainstGrn(db, TID, invoice(10, 10000))).ok).toBe(true);
    const res = await validateInvoiceAgainstGrn(db, TID, invoice(10, 10500));
    expect(res.ok).toBe(false);
    expect(res.code).toBe('PRICE_MISMATCH');
  });

  it('retur yang terikat invoice hidup tidak memotong ulang; retur lepas memotong qty', async () => {
    await db.collection('hutang').insertOne({
      id: 'h-a', tenantId: TID, noDO: 'DO-1', noPO: 'PO-1', referenceType: 'VENDOR_INVOICE',
      vendorInvoiceId: 'inv-a', noInvoice: 'INV-A', approvalStatus: 'APPROVED',
      items: [{ lineId: 'l1', kode: 'BERAS', satuan: 'KG', qty: 6 }],
    });
    await db.collection('vendor_returns').insertOne({
      id: 'rtv-a', tenantId: TID, noDO: 'DO-1', status: 'POSTED', source: 'hutang', hutangId: 'h-a',
      items: [{ grnLineId: 'l1', localKode: 'BERAS', vendorKode: 'BERAS', satuan: 'KG', qty: 2, harga: 10000 }],
    });

    // Sinkron ulang invoice A sendiri: retur miliknya dikreditkan lewat CN, qty 6 tetap sah.
    const resyncA = await validateInvoiceAgainstGrn(db, TID, invoice(6, 10000, 'inv-a'), { excludeHutangId: 'h-a' });
    expect(resyncA.ok).toBe(true);

    // Invoice B: GRN 10 − ditagih A 6 = 4, dan PO 10 − (6 − 2 retur A) = 6.
    expect((await validateInvoiceAgainstGrn(db, TID, invoice(4))).ok).toBe(true);
    expect((await validateInvoiceAgainstGrn(db, TID, invoice(5))).code).toBe('GRN_ALREADY_INVOICED');

    await db.collection('vendor_returns').insertOne({
      id: 'rtv-loose', tenantId: TID, noDO: 'DO-1', status: 'POSTED', source: 'qc-reject', hutangId: 'h-rejected',
      items: [{ grnLineId: 'l1', vendorKode: 'BERAS', localKode: 'BERAS', satuan: 'KG', qty: 1, harga: 10000 }],
    });
    expect((await validateInvoiceAgainstGrn(db, TID, invoice(4))).ok).toBe(false);
    expect((await validateInvoiceAgainstGrn(db, TID, invoice(3))).ok).toBe(true);

    await db.collection('vendor_returns').insertOne({
      id: 'rtv-grn', tenantId: TID, noDO: 'DO-1', status: 'POSTED', source: 'grn-reject',
      items: [{ grnLineId: 'l1', vendorKode: 'BERAS', satuan: 'KG', qty: 3, harga: 10000 }],
    });
    expect((await validateInvoiceAgainstGrn(db, TID, invoice(3))).ok).toBe(true);
  });

  it('jurnal: posting sekali, void menandai, posting ulang, void lama tetap menetralkan', async () => {
    const hutang = {
      id: 'h-j', tenantId: TID, noInvoice: 'INV-J', noDO: 'DO-X', tanggal: new Date(),
      total: 111000, ppn: 11000, glPostingBase: { subTotal: 100000, ppn: 11000, total: 111000 },
    };
    expect(await postVendorHutangJournal(db, hutang, { userName: 'u' })).toBe('posted');
    expect(await postVendorHutangJournal(db, hutang, { userName: 'u' })).toBe('exists');

    expect(await voidVendorHutangJournal(db, hutang, { userName: 'u', keterangan: 'uji' })).toBe(true);
    expect(await findActiveVendorHutangJournal(db, TID, 'h-j')).toBeNull();
    expect(await voidVendorHutangJournal(db, hutang, { userName: 'u', keterangan: 'uji' })).toBe(false);
    const voids = await db.collection('jurnal').find({ tenantId: TID, sourceType: 'AUTO_HUTANG_VENDOR_VOID', sourceId: 'h-j' }).toArray();
    expect(voids).toHaveLength(1);
    expect(voids[0].voidOfJournalId).toBeTruthy();

    expect(await postVendorHutangJournal(db, hutang, { userName: 'u' })).toBe('posted');
    expect(await findActiveVendorHutangJournal(db, TID, 'h-j')).not.toBeNull();

    await db.collection('jurnal').insertMany([
      { id: 'legacy-post', tenantId: TID, sourceType: 'AUTO_HUTANG_VENDOR', sourceId: 'h-legacy', details: [], createdAt: new Date() },
      { id: 'legacy-void', tenantId: TID, sourceType: 'AUTO_HUTANG_VENDOR_VOID', sourceId: 'h-legacy', details: [], createdAt: new Date() },
    ]);
    expect(await findActiveVendorHutangJournal(db, TID, 'h-legacy')).toBeNull();
  });

  it('jurnal approve jatuh ke hari ini bila tanggal tagihan ada di periode terkunci', async () => {
    await db.collection('tenant_settings').updateOne(
      { tenantId: TID },
      { $set: { periodLockedUntil: new Date('2026-01-31') } },
      { upsert: true },
    );
    const hutang = { id: 'h-lock', tenantId: TID, noInvoice: 'INV-L', tanggal: new Date('2026-01-15'), total: 5000, ppn: 0 };
    expect(await postVendorHutangJournal(db, hutang, { userName: 'u' })).toBe('posted');
    const j = await db.collection('jurnal').findOne({ tenantId: TID, sourceType: 'AUTO_HUTANG_VENDOR', sourceId: 'h-lock' });
    expect(new Date(j!.tanggal).getTime()).toBeGreaterThan(new Date('2026-01-31').getTime());
  });

  it('jurnal CN ditunda sampai tagihan dijurnal; void tagihan membalik CN lalu dijurnal ulang', async () => {
    const hutang = { id: 'h-cn', tenantId: TID, noInvoice: 'INV-CN', tanggal: new Date(), total: 50000, ppn: 0 };
    await db.collection('hutang').insertOne({ ...hutang, creditNotes: [{ creditNoteId: 'cn-1', amount: 5000 }] });
    const cn = {
      sourceType: 'AUTO_CN_VENDOR' as const,
      sourceId: 'cn-1',
      keterangan: 'CN uji',
      userName: 'u',
      details: [
        { rekeningKode: '2-1100', rekeningNama: 'Hutang', debet: 5000, kredit: 0, keterangan: 'CN' },
        { rekeningKode: '5-1000', rekeningNama: 'HPP', debet: 0, kredit: 5000, keterangan: 'CN' },
      ],
    };
    const cnJournals = () => db.collection('jurnal').find({ tenantId: TID, sourceType: 'AUTO_CN_VENDOR' }).toArray();

    expect(await postOrDeferNoteJournal(db, undefined, { tenantId: TID, hutangId: 'h-cn', journal: cn })).toBe('deferred');
    expect(await cnJournals()).toHaveLength(0);

    expect(await postVendorHutangJournal(db, hutang, { userName: 'u' })).toBe('posted');
    expect(await cnJournals()).toHaveLength(1);
    let row = await db.collection('hutang').findOne({ id: 'h-cn' });
    expect(row?.deferredNoteJournals).toBeUndefined();
    expect(row?.postedNoteJournals).toHaveLength(1);

    expect(await voidVendorHutangJournal(db, hutang, { userName: 'u', keterangan: 'tolak' })).toBe(true);
    const voids = await db.collection('jurnal').find({ tenantId: TID, sourceType: 'AUTO_CN_VENDOR_VOID' }).toArray();
    expect(voids).toHaveLength(1);
    expect(voids[0].voidOfJournalId).toBeTruthy();
    row = await db.collection('hutang').findOne({ id: 'h-cn' });
    expect(row?.deferredNoteJournals).toHaveLength(1);
    expect(row?.postedNoteJournals).toHaveLength(0);

    expect(await postVendorHutangJournal(db, hutang, { userName: 'u' })).toBe('posted');
    const all = await cnJournals();
    expect(all).toHaveLength(2);
    expect(all.filter((j) => !j.voidedAt).map((j) => j.sourceId)).toEqual(['cn-1#2']);

    expect(await postOrDeferNoteJournal(db, undefined, {
      tenantId: TID, hutangId: 'h-cn', journal: { ...cn, sourceId: 'cn-2' },
    })).toBe('posted');
    expect(await cnJournals()).toHaveLength(3);
  });

  it('toleransi harga 3-way per tenant menggantikan default 2%', async () => {
    const inv = { ...invoice(1, 10500, 'inv-tol'), noDO: 'DO-1' };
    expect((await validateInvoiceAgainstGrn(db, TID, inv)).code).toBe('PRICE_MISMATCH');
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { threeWayPriceTolerancePct: 10 } }, { upsert: true });
    expect((await validateInvoiceAgainstGrn(db, TID, inv)).code).not.toBe('PRICE_MISMATCH');
    expect((await validateInvoiceAgainstGrn(db, TID, inv, { priceTolerancePct: 0, qtyTolerancePct: 0 })).code).toBe('PRICE_MISMATCH');
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $unset: { threeWayPriceTolerancePct: '' } });
  });

  it('kirim ulang invoice memperbarui hutang lama tanpa vendorTenantId, tidak membuat ganda', async () => {
    await db.collection('hutang').insertOne({
      id: 'h-legacy', tenantId: TID, noHutang: 'HT-LEGACY', vendorInvoiceId: 'inv-legacy',
      noDO: 'DO-1', total: 100000, sisa: 100000, terbayar: 0, status: 'PENDING_APPROVAL',
      approvalStatus: 'PENDING', matchStatus: 'EXCEPTION', items: [], createdAt: new Date(),
    });
    const res = await createHutangFromVendorInvoice(db, TID, invoice(10, 10000, 'inv-legacy'), 'Vendor-A');
    expect('error' in res && res.error).toBeFalsy();
    expect(res.hutangId).toBe('h-legacy');
    expect(await db.collection('hutang').countDocuments({ tenantId: TID, vendorInvoiceId: 'inv-legacy' })).toBe(1);
  });

  it('hutang baru tidak menandai GRN yang sudah dibalik', async () => {
    await db.collection('goods_receipts').insertMany([
      { id: 'grn-rev', tenantId: TID, noDO: 'DO-R', noPO: 'PO-1', status: 'REVERSED', items: [] },
      { id: 'grn-ok', tenantId: TID, noDO: 'DO-R', noPO: 'PO-1', status: 'POSTED', items: [] },
    ]);
    const res = await createHutangFromVendorInvoice(db, TID, { ...invoice(1, 10000, 'inv-rev'), noDO: 'DO-R' }, null);
    expect('error' in res && res.error).toBeFalsy();
    const rev = await db.collection('goods_receipts').findOne({ id: 'grn-rev' });
    const ok = await db.collection('goods_receipts').findOne({ id: 'grn-ok' });
    expect(rev?.vendorInvoiceId).toBeUndefined();
    expect(ok?.vendorInvoiceId).toBe('inv-rev');
  });

  it('basis posting tanpa glPostingBase mengeluarkan debit note', () => {
    expect(vendorHutangPostingBase({ total: 130000, ppn: 11000, debitNotes: [{ amount: 19000 }] }))
      .toEqual({ subTotal: 100000, ppn: 11000, total: 111000 });
  });
});
