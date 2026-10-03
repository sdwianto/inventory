/**
 * Fase 2 pajak — hutang vendor ber-PPN: pembeli PKP vs non-PKP sampai ke jurnal, header pajak tidak konsisten,
 * CN melebihi sisa hutang, dan repair GRN yang tidak boleh menimpa total ber-PPN.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';

vi.mock('@/lib/api/transaction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/transaction')>('@/lib/api/transaction');
  const testDb = () => (globalThis as { __hutangPkpDb?: Db }).__hutangPkpDb!;
  return {
    ...actual,
    runInTransactionOrFallback: (fn: Parameters<typeof actual.runInTransactionOrFallback>[0]) => (
      actual.runInTransactionOnDb(testDb(), fn)
    ),
  };
});

import { applyCreditNoteFromVendor, createHutangFromVendorInvoice } from '@/lib/api/hutang-from-vendor';
import { fixHutangApprovalIfNeeded } from '@/lib/api/hutang-reconcile';
import type { GrnDoc, HutangDoc } from '@/types/documents';
import type { JournalDetail } from '@/types/finance';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const NPWP = '0012345678901000';
const amt = (details: JournalDetail[], kode: string) =>
  details.filter((d) => d.rekeningKode === kode).reduce((s, d) => s + (d.debet || 0) - (d.kredit || 0), 0);

describe.skipIf(!MongoMemoryReplSet)('hutang vendor ber-PPN (PKP vs non-PKP)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('hutang_pkp_it');
    (globalThis as { __hutangPkpDb?: Db }).__hutangPkpDb = db;
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  async function seedTenant(tid: string, { pkp }: { pkp: boolean }) {
    await db.collection('tenant_settings').insertOne({
      tenantId: tid,
      companyNPWP: NPWP,
      ...(pkp ? { tax: { pkp: true, pkpSejak: null } } : {}),
    });
    await db.collection('goods_receipts').insertOne({
      id: `grn-${tid}`, tenantId: tid, noDO: `DO-${tid}`, noPO: `PO-${tid}`, status: 'POSTED',
      items: [
        { lineId: 'l1', vendorKode: 'BERAS', satuan: 'KG', qtyOrdered: 10, qtyReceived: 10, harga: 10000 },
        { lineId: 'l2', vendorKode: 'GULA', satuan: 'KG', qtyOrdered: 5, qtyReceived: 5, harga: 20000 },
      ],
    });
    await db.collection('customer_purchase_orders').insertOne({
      id: `po-${tid}`, tenantId: tid, noPO: `PO-${tid}`, status: 'RECEIVED',
      items: [
        { lineId: 'l1', vendorKode: 'BERAS', satuan: 'KG', qty: 10, estimasiHarga: 10000 },
        { lineId: 'l2', vendorKode: 'GULA', satuan: 'KG', qty: 5, estimasiHarga: 20000 },
      ],
      vendorSoSnapshot: {
        items: [
          { kode: 'BERAS', satuan: 'KG', qty: 10, harga: 10000 },
          { kode: 'GULA', satuan: 'KG', qty: 5, harga: 20000 },
        ],
      },
    });
  }

  const invoice = (tid: string, over: Record<string, unknown> = {}) => ({
    invoiceId: `inv-${tid}`,
    noInvoice: `INV-${tid}`,
    noDO: `DO-${tid}`,
    noPO: `PO-${tid}`,
    subTotal: 200000,
    diskonNota: 0,
    dpp: 200000,
    ppn: 22000,
    total: 222000,
    ppnRate: 11,
    hargaTermasukPajak: false,
    items: [
      { lineId: 'l1', kode: 'BERAS', satuan: 'KG', qty: 10, harga: 10000, jumlah: 100000, ppn: 11000 },
      { lineId: 'l2', kode: 'GULA', satuan: 'KG', qty: 5, harga: 20000, jumlah: 100000, ppn: 11000 },
    ],
    ...over,
  });

  const hutangOf = async (tid: string) => (await db.collection('hutang').findOne({ tenantId: tid, vendorInvoiceId: `inv-${tid}` })) as HutangDoc | null;
  const activeJournal = async (tid: string, hutangId: string) => db.collection('jurnal').findOne({
    tenantId: tid, sourceType: 'AUTO_HUTANG_VENDOR', sourceId: hutangId, voidedAt: { $exists: false },
  }) as Promise<{ details: JournalDetail[] } | null>;

  it('PKP: PPN dikreditkan ke PPN Masukan, nilai pajak tersimpan di hutang', async () => {
    const tid = 'it-pkp';
    await seedTenant(tid, { pkp: true });
    const res = await createHutangFromVendorInvoice(db, tid, invoice(tid), 'vendor-a');
    expect('error' in res && res.error).toBeFalsy();
    const h = (await hutangOf(tid))!;
    expect(h).toMatchObject({ subTotal: 200000, diskonNota: 0, dpp: 200000, ppn: 22000, total: 222000, ppnRate: 11, ppnDikreditkan: true });
    expect(h.glPostingBase).toEqual({ subTotal: 200000, ppn: 22000, total: 222000 });
    const j = (await activeJournal(tid, String(h.id)))!;
    expect(j).not.toBeNull();
    expect(amt(j.details, '10410')).toBe(22000);
    expect(amt(j.details, '20010')).toBe(-222000);
  });

  it('non-PKP: PPN tidak dikreditkan, ikut nilai barang', async () => {
    const tid = 'it-nonpkp';
    await seedTenant(tid, { pkp: false });
    await createHutangFromVendorInvoice(db, tid, invoice(tid), 'vendor-a');
    const h = (await hutangOf(tid))!;
    expect(h.ppnDikreditkan).toBe(false);
    expect(h.ppn).toBe(22000);
    const j = (await activeJournal(tid, String(h.id)))!;
    expect(amt(j.details, '10410')).toBe(0);
    expect(amt(j.details, '20010')).toBe(-222000);
    const biaya = amt(j.details, '10310') + amt(j.details, '20020') + amt(j.details, '31030');
    expect(biaya).toBe(222000);
  });

  it('header pajak tidak konsisten: EXCEPTION TAX_TOTAL_MISMATCH tanpa jurnal', async () => {
    const tid = 'it-mismatch';
    await seedTenant(tid, { pkp: true });
    await createHutangFromVendorInvoice(db, tid, invoice(tid, { total: 230000 }), 'vendor-a');
    const h = (await hutangOf(tid))!;
    expect(h.matchStatus).toBe('EXCEPTION');
    expect(h.matchCode).toBe('TAX_TOTAL_MISMATCH');
    expect(await activeJournal(tid, String(h.id))).toBeNull();
  });

  it('CN atas invoice lunas: kelebihan jadi Piutang Vendor, PPN nota dari vendor', async () => {
    const tid = 'it-cn';
    await seedTenant(tid, { pkp: true });
    await createHutangFromVendorInvoice(db, tid, invoice(tid), 'vendor-a');
    const h = (await hutangOf(tid))!;
    await db.collection('hutang').updateOne({ id: h.id }, { $set: { terbayar: 222000, sisa: 0, status: 'LUNAS' } });

    const res = await applyCreditNoteFromVendor(db, tid, {
      invoiceId: `inv-${tid}`, creditNoteId: 'cn-1', noCN: 'CN-1', total: 11100, ppn: 1100, ppnRate: 11,
    } as never, 'vendor-a');
    expect(res).toMatchObject({ action: 'credit_applied', reduced: 0, vendorCredit: 11100 });

    const after = (await hutangOf(tid))!;
    expect(after.kreditVendorKelebihan).toBe(11100);
    expect(after.sisa).toBe(0);
    const cn = await db.collection('jurnal').findOne({ tenantId: tid, sourceType: 'AUTO_CN_VENDOR' }) as { details: JournalDetail[] } | null;
    expect(cn).not.toBeNull();
    expect(amt(cn!.details, '10250')).toBe(11100);
    expect(amt(cn!.details, '20010')).toBe(0);
    expect(amt(cn!.details, '10410')).toBe(-1100);

    const again = await applyCreditNoteFromVendor(db, tid, {
      invoiceId: `inv-${tid}`, creditNoteId: 'cn-1', noCN: 'CN-1', total: 11100, ppn: 1100, ppnRate: 11,
    } as never, 'vendor-a');
    expect(again).toMatchObject({ action: 'already_applied' });
  });

  it('CN seluruhnya jadi kredit vendor tidak mengubah status pembayaran (PAID_EXTERNAL)', async () => {
    const tid = 'it-cn-ext';
    await seedTenant(tid, { pkp: true });
    await createHutangFromVendorInvoice(db, tid, invoice(tid), 'vendor-a');
    const h = (await hutangOf(tid))!;
    await db.collection('hutang').updateOne({ id: h.id }, {
      $set: { terbayar: 222000, sisa: 0, status: 'PAID_EXTERNAL', approvalStatus: 'PAID_EXTERNAL' },
    });
    const res = await applyCreditNoteFromVendor(db, tid, {
      invoiceId: `inv-${tid}`, creditNoteId: 'cn-x', noCN: 'CN-X', total: 11100, ppn: 1100, ppnRate: 11,
    } as never, 'vendor-a');
    expect(res).toMatchObject({ action: 'credit_applied', reduced: 0, vendorCredit: 11100 });
    const after = (await hutangOf(tid))!;
    expect(after).toMatchObject({ status: 'PAID_EXTERNAL', approvalStatus: 'PAID_EXTERNAL', terbayar: 222000, sisa: 0 });
  });

  it('reset ke PENDING_REVIEW mempertahankan pembayaran & CN yang tercatat', async () => {
    const tid = 'it-reset';
    await seedTenant(tid, { pkp: true });
    await createHutangFromVendorInvoice(db, tid, invoice(tid), 'vendor-a');
    const h = (await hutangOf(tid))!;
    await db.collection('hutang_pembayaran').insertOne({ id: 'pay-1', tenantId: tid, hutangId: h.id, amount: 50000 });
    await db.collection('hutang').updateOne({ id: h.id }, {
      $set: { terbayar: 222000, sisa: 0, status: 'LUNAS', approvalStatus: 'LUNAS' },
    });
    const grn = (await db.collection('goods_receipts').findOne({ id: `grn-${tid}` })) as unknown as GrnDoc;
    expect(await fixHutangApprovalIfNeeded(db, (await hutangOf(tid))!, grn)).toBe(true);
    const after = (await hutangOf(tid))!;
    expect(after).toMatchObject({ status: 'PENDING_REVIEW', terbayar: 50000, sisa: 172000, total: 222000 });
  });

  it('repair GRN: hutang ber-PPN yang sudah sesuai tidak disentuh; qty turun → nilai & jurnal dikoreksi', async () => {
    const tid = 'it-repair';
    await seedTenant(tid, { pkp: true });
    await createHutangFromVendorInvoice(db, tid, invoice(tid), 'vendor-a');
    let h = (await hutangOf(tid))!;
    const grn = (await db.collection('goods_receipts').findOne({ id: `grn-${tid}` })) as unknown as GrnDoc;

    expect(await fixHutangApprovalIfNeeded(db, h, grn)).toBe(false);
    expect((await hutangOf(tid))!.total).toBe(222000);

    const lessGrn = {
      ...grn,
      items: grn.items.map((it) => (it.lineId === 'l1' ? { ...it, qtyReceived: 5 } : it)),
    } as GrnDoc;
    h = (await hutangOf(tid))!;
    expect(await fixHutangApprovalIfNeeded(db, h, lessGrn)).toBe(true);
    const fixed = (await hutangOf(tid))!;
    expect(fixed).toMatchObject({ subTotal: 150000, ppn: 16500, total: 166500, sisa: 166500 });
    const j = (await activeJournal(tid, String(fixed.id)))!;
    expect(amt(j.details, '20010')).toBe(-166500);
    expect(amt(j.details, '10410')).toBe(16500);
    const voided = await db.collection('jurnal').countDocuments({ tenantId: tid, sourceType: 'AUTO_HUTANG_VENDOR_VOID' });
    expect(voided).toBe(1);
  });
});
