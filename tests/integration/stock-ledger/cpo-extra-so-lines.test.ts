/**
 * Barang SO vendor di luar PO customer — skenario INV2610000013 zulmy / B402689 (Mongo replica set):
 * Garam dipesan di PO 077 ke toko-palapa, vendor zulmy menambahkannya ke SO untuk PO 081.
 * Harus: baris masuk PO 081, baris PO 077 tertaut (bukan sekadar batal), tagihan yang tertahan
 * otomatis cocok kembali, dan cakupan pengadaan rencana PO 077 tetap terhitung.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';

vi.mock('@/lib/api/transaction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/transaction')>('@/lib/api/transaction');
  const testDb = () => (globalThis as { __cpoExtraDb?: Db }).__cpoExtraDb!;
  return {
    ...actual,
    runInTransactionOrFallback: (fn: Parameters<typeof actual.runInTransactionOrFallback>[0]) => (
      actual.runInTransactionOnDb(testDb(), fn)
    ),
  };
});

vi.mock('@/lib/api/vendor-line-decision-push', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/vendor-line-decision-push')>('@/lib/api/vendor-line-decision-push');
  return { ...actual, enqueueVendorLineDecisionPush: vi.fn(async () => {}) };
});

const { syncCpoFromVendorEvent } = await import('@/lib/api/cpo-status-sync');
const { assertCanApproveInvoice } = await import('@/lib/api/hutang-approval');
const { findActiveVendorHutangJournal } = await import('@/lib/api/hutang-vendor-journal');
const { expandRelocatedLines } = await import('@/lib/api/cpo-relocated-lines');
const { detectPoVendorLineRecon } = await import('@/lib/recon/po-vendor-line-recon');
const { decideVendorLine } = await import('@/lib/api/cpo-vendor-line-acceptance');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };
let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-cpo-extra';

describe.skipIf(!MongoMemoryReplSet)('Barang SO vendor di luar PO (Mongo replica set)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('cpo_extra_so_lines_it');
    (globalThis as { __cpoExtraDb?: Db }).__cpoExtraDb = db;
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  const now = new Date();

  beforeEach(async () => {
    for (const c of ['customer_purchase_orders', 'goods_receipts', 'hutang', 'products', 'journals', 'journal_entries', 'audit_log', 'notifications', 'vendor_returns', 'integration_outbox', 'tenant_settings']) {
      await db.collection(c).deleteMany({});
    }
    await db.collection('products').insertOne({
      id: 'local-garam', tenantId: TID, kode: 'B402689', nama: 'Garam 250g Kapal', aktif: true,
      vendorTenantId: 'zulmy', vendorStokId: 'v-garam',
    });
    await db.collection('customer_purchase_orders').insertMany([
      {
        id: 'po-77', tenantId: TID, noPO: 'CPO-77', status: 'CONFIRMED', vendorTenantId: 'multi',
        productionPlanId: 'plan-1', updatedAt: now,
        vendorSubmissions: [{ vendorTenantId: 'toko-palapa', vendorSoId: 'so-tp', vendorNoSO: 'SO-TP', status: 'SYNCED' }],
        items: [
          { lineId: 'po77-garam', localStokId: 'local-garam', vendorTenantId: 'toko-palapa', vendorKode: 'B402689', kode: 'B402689', vendorStokId: 'tp-garam', satuan: 'PCS', qty: 5, estimasiHarga: 2300 },
          { lineId: 'po77-beras', localStokId: 'local-beras', vendorTenantId: 'toko-palapa', vendorKode: 'B335256', kode: 'B335256', vendorStokId: 'tp-beras', satuan: 'SAK', qty: 3 },
        ],
      },
      {
        id: 'po-81', tenantId: TID, noPO: 'CPO-81', status: 'CONFIRMED', vendorTenantId: 'multi', updatedAt: now,
        vendorSubmissions: [{ vendorTenantId: 'zulmy', vendorSoId: 'so-z', vendorNoSO: 'SO-Z', status: 'SYNCED' }],
        items: [
          { lineId: 'po81-bakso', localStokId: 'local-bakso', vendorTenantId: 'zulmy', vendorKode: 'B165667', kode: 'B165667', vendorStokId: 'v-bakso', satuan: 'PCS', qty: 1, estimasiHarga: 25000 },
          { lineId: 'po81-isolasi', localStokId: 'local-isolasi', vendorTenantId: 'abiliyan', vendorKode: 'B378322', kode: 'B378322', satuan: 'ROL', qty: 8, estimasiHarga: 5000 },
        ],
      },
    ]);
  });

  const zulmyConfirmed = () => syncCpoFromVendorEvent(db, TID, 'sales_order.confirmed', {
    customerPoId: 'po-81', noPO: 'CPO-81', salesOrderId: 'so-z', noSO: 'SO-Z', vendorTenantId: 'zulmy',
    items: [
      { lineId: 'so-bakso', stokId: 'v-bakso', kode: 'B165667', nama: 'Bakso Sapi Salam', qty: 1, satuan: 'PCS', harga: 25000 },
      { lineId: 'so-garam', stokId: 'v-garam', kode: 'B402689', nama: 'Garam 250g Kapal', qty: 5, satuan: 'PCS', harga: 2250, outsidePo: true },
    ],
  });
  const tokoPalapaConfirmed = () => syncCpoFromVendorEvent(db, TID, 'sales_order.confirmed', {
    customerPoId: 'po-77', noPO: 'CPO-77', salesOrderId: 'so-tp', noSO: 'SO-TP', vendorTenantId: 'toko-palapa',
    items: [{ lineId: 'tp-l1', stokId: 'tp-beras', kode: 'B335256', qty: 3, satuan: 'SAK', harga: 400000 }],
  });

  const items = async (id: string) => ((await db.collection('customer_purchase_orders').findOne({ id }))?.items || []) as Array<Record<string, unknown>>;

  it('SO vendor dengan barang di luar PO → baris ditambahkan ke PO, idempoten', async () => {
    const res = await zulmyConfirmed();
    expect(res).toMatchObject({ action: 'updated', addedVendorLines: ['B402689'] });
    const lines = await items('po-81');
    const garam = lines.find((l) => l.kode === 'B402689');
    expect(garam).toMatchObject({
      lineId: 'so-garam', localStokId: 'local-garam', vendorTenantId: 'zulmy', qty: 5, estimasiHarga: 2250, addedFromVendorSo: true,
    });
    expect(lines.find((l) => l.lineId === 'po81-isolasi')?.cancelled).toBeUndefined();

    await zulmyConfirmed();
    expect((await items('po-81')).filter((l) => l.kode === 'B402689')).toHaveLength(1);
  });

  it('baris PO asal yang dibatalkan "Tidak ada di SO" tertaut ke baris tujuan (dua urutan event)', async () => {
    await tokoPalapaConfirmed();
    expect((await items('po-77')).find((l) => l.lineId === 'po77-garam')).toMatchObject({ cancelled: true });
    await zulmyConfirmed();

    const from = (await items('po-77')).find((l) => l.lineId === 'po77-garam');
    const to = (await items('po-81')).find((l) => l.lineId === 'so-garam');
    expect(from?.relocatedTo).toMatchObject({ poId: 'po-81', noPO: 'CPO-81', lineId: 'so-garam', vendorTenantId: 'zulmy' });
    expect(to?.relocatedFrom).toMatchObject({ poId: 'po-77', noPO: 'CPO-77', lineId: 'po77-garam', vendorTenantId: 'toko-palapa' });
    expect(await db.collection('audit_log').countDocuments({ action: 'CPO_LINE_RELOCATED' })).toBe(1);

    // Urutan terbalik: barang ditambahkan dulu, pembatalan di PO asal menyusul.
    await db.collection('customer_purchase_orders').updateOne({ id: 'po-77' }, { $unset: { 'items.0.relocatedTo': '', 'items.0.cancelled': '', 'items.0.cancelReason': '' } });
    await db.collection('customer_purchase_orders').updateOne({ id: 'po-81' }, { $unset: { 'items.2.relocatedFrom': '' } });
    await tokoPalapaConfirmed();
    expect((await items('po-77')).find((l) => l.lineId === 'po77-garam')?.relocatedTo).toMatchObject({ noPO: 'CPO-81' });
  });

  it('cakupan pengadaan PO asal mengikuti qty diterima di PO tujuan', async () => {
    await tokoPalapaConfirmed();
    await zulmyConfirmed();
    await db.collection('customer_purchase_orders').updateOne(
      { id: 'po-81', 'items.lineId': 'so-garam' },
      { $set: { 'items.$.qtyReceived': 5 } },
    );
    const po77 = await items('po-77');
    const expanded = await expandRelocatedLines(db, TID, po77, new Set(['po-77']));
    expect(expanded.find((l) => l.lineId === 'po77-garam')).toMatchObject({ cancelled: false, qty: 5, qtyReceived: 5, relocatedVirtual: true });
    // PO tujuan sudah ikut dihitung → tidak digandakan.
    const notDup = await expandRelocatedLines(db, TID, po77, new Set(['po-77', 'po-81']));
    expect(notDup.find((l) => l.lineId === 'po77-garam')?.cancelled).toBe(true);
  });

  it('tagihan EXCEPTION "tidak ada di PO" dihitung ulang → MATCHED + jurnal; sebelum itu tetap bisa override', async () => {
    await db.collection('goods_receipts').insertOne({
      id: 'grn-z', tenantId: TID, noGRN: 'GRN-Z', noDO: 'DO-13', noPO: 'CPO-81', status: 'POSTED', vendorTenantId: 'zulmy',
      items: [
        { lineId: 'so-bakso', vendorKode: 'B165667', satuan: 'PCS', qtyReceived: 1, harga: 25000 },
        { lineId: 'so-garam', vendorKode: 'B402689', satuan: 'PCS', qtyReceived: 5, harga: 2250 },
      ],
    });
    await db.collection('customer_purchase_orders').updateOne({ id: 'po-81' }, {
      $set: {
        status: 'PARTIAL_RECEIVED',
        appliedReceiveGrnIds: ['grn-z'],
        qtySyncVersion: 3,
        'items.0.qtyReceived': 1,
        vendorSoSnapshot: { noSO: 'SO-Z', items: [{ kode: 'B165667', satuan: 'PCS', qty: 1, harga: 25000 }, { kode: 'B402689', satuan: 'PCS', qty: 5, harga: 2250 }] },
      },
    });
    const hutang = {
      id: 'h-z', tenantId: TID, referenceType: 'VENDOR_INVOICE', noHutang: 'HT-Z', noInvoice: 'INV-13', vendorInvoiceId: 'vinv-z',
      noPO: 'CPO-81', noDO: 'DO-13', vendorTenantId: 'zulmy', approvalStatus: 'PENDING_REVIEW', status: 'PENDING_REVIEW',
      matchStatus: 'EXCEPTION', matchError: '3-way match PO: B402689 (PCS) tidak ada di PO', matchCode: 'QTY_MISMATCH',
      total: 36250, subTotal: 36250, ppn: 0, tanggal: now, createdAt: new Date(now.getTime() - 3 * 3_600_000),
      items: [
        { lineId: 'so-bakso', kode: 'B165667', satuan: 'PCS', qty: 1, harga: 25000, jumlah: 25000 },
        { lineId: 'so-garam', kode: 'B402689', satuan: 'PCS', qty: 5, harga: 2250, jumlah: 11250 },
      ],
    };
    await db.collection('hutang').insertOne(hutang);

    // Sebelum sinkron: gerbang tidak lagi memblokir mutlak — override bisa dipakai.
    expect(await assertCanApproveInvoice(db, hutang as never, { overrideMatch: true })).toEqual({ ok: true });
    const recon = await detectPoVendorLineRecon(db, TID, { now });
    expect(recon.findings.map((f) => f.kind).sort()).toEqual(['HUTANG_OFF_PO_PENDING']);

    // Kasus produksi: Garam dipesan di PO 77 (toko-palapa), dipindah vendor zulmy ke SO untuk PO 81.
    await tokoPalapaConfirmed();
    await zulmyConfirmed();

    // GRN sudah diterapkan sebelum baris ada: qty diterima diisi dari GRN, versi CAS naik.
    const po81 = await db.collection('customer_purchase_orders').findOne({ id: 'po-81' });
    expect(Number(po81?.qtySyncVersion)).toBeGreaterThan(3);
    expect((po81?.items as Array<Record<string, unknown>>).find((l) => l.lineId === 'so-garam'))
      .toMatchObject({
        qtyReceived: 5, qtyShipped: 5, qtyBackorder: 0,
        vendorLineAcceptance: expect.objectContaining({
          status: 'ACCEPTED', mode: 'AUTO_RELOCATION', rule: expect.objectContaining({ fromNoPO: 'CPO-77', fromPrice: 2300 }),
        }),
      });
    expect(await db.collection('audit_log').countDocuments({ action: 'CPO_VENDOR_LINE_ACCEPTED', entityId: 'po-81' })).toBe(1);
    expect(await db.collection('integration_outbox').findOne({ aggregateId: 'po-81:so-garam' }))
      .toMatchObject({ type: 'ENSURE_PUSH_VENDOR_LINE_DECISION', status: 'PENDING', payload: expect.objectContaining({ decision: 'ACCEPTED', mode: 'AUTO_RELOCATION' }) });
    expect(await db.collection('audit_log').countDocuments({ action: 'CPO_VENDOR_LINE_ADDED', entityId: 'po-81' })).toBe(1);

    const after = await db.collection('hutang').findOne({ id: 'h-z' });
    expect(after).toMatchObject({ matchStatus: 'MATCHED', matchError: null, approvalStatus: 'PENDING_REVIEW' });
    expect(await findActiveVendorHutangJournal(db, TID, 'h-z')).toBeTruthy();
    expect(await db.collection('audit_log').countDocuments({ action: 'HUTANG_REMATCHED', entityId: 'h-z' })).toBe(1);
    expect(await assertCanApproveInvoice(db, after as never)).toEqual({ ok: true });
  });

  it('tagihan dengan header pajak tidak konsisten tetap EXCEPTION setelah dihitung ulang', async () => {
    await db.collection('goods_receipts').insertOne({
      id: 'grn-z', tenantId: TID, noGRN: 'GRN-Z', noDO: 'DO-13', noPO: 'CPO-81', status: 'POSTED', vendorTenantId: 'zulmy',
      items: [{ lineId: 'so-garam', vendorKode: 'B402689', satuan: 'PCS', qtyReceived: 5, harga: 2250 }],
    });
    await db.collection('customer_purchase_orders').updateOne({ id: 'po-81' }, {
      $set: { vendorSoSnapshot: { noSO: 'SO-Z', items: [{ kode: 'B402689', satuan: 'PCS', qty: 5, harga: 2250 }] } },
    });
    await db.collection('hutang').insertOne({
      id: 'h-tax', tenantId: TID, referenceType: 'VENDOR_INVOICE', noHutang: 'HT-T', noInvoice: 'INV-T', noPO: 'CPO-81', noDO: 'DO-13',
      vendorTenantId: 'zulmy', approvalStatus: 'PENDING_REVIEW', matchStatus: 'EXCEPTION', matchCode: 'QTY_MISMATCH',
      matchError: '3-way match PO: B402689 (PCS) tidak ada di PO', subTotal: 11250, ppn: 0, total: 99999, createdAt: now,
      items: [{ lineId: 'so-garam', kode: 'B402689', satuan: 'PCS', qty: 5, harga: 2250, jumlah: 11250 }],
    });
    await tokoPalapaConfirmed();
    await zulmyConfirmed();
    const h = await db.collection('hutang').findOne({ id: 'h-tax' });
    expect(h).toMatchObject({ matchStatus: 'EXCEPTION', matchCode: 'TAX_TOTAL_MISMATCH' });
    expect(await findActiveVendorHutangJournal(db, TID, 'h-tax')).toBeFalsy();
  });

  it('rekonsiliasi melaporkan barang SO vendor yang belum masuk PO (sinkron terlewat)', async () => {
    await db.collection('customer_purchase_orders').updateOne({ id: 'po-81' }, {
      $set: {
        'vendorSubmissions.0.vendorSo': {
          noSO: 'SO-Z',
          items: [
            { lineId: 'so-bakso', stokId: 'v-bakso', kode: 'B165667', qty: 1 },
            { lineId: 'so-garam', stokId: 'v-garam', kode: 'B402689', nama: 'Garam 250g Kapal', qty: 5 },
          ],
        },
      },
    });
    const recon = await detectPoVendorLineRecon(db, TID, { now });
    expect(recon.findings).toEqual([
      expect.objectContaining({ kind: 'PO_VENDOR_SO_LINE_MISSING', refNo: 'CPO-81', kode: 'B402689', actual: 5 }),
    ]);
  });
  const hutangGaram = (id: string) => ({
    id, tenantId: TID, referenceType: 'VENDOR_INVOICE', noHutang: `HT-${id}`, noInvoice: `INV-${id}`, vendorInvoiceId: `v-${id}`,
    noPO: 'CPO-81', noDO: 'DO-13', vendorTenantId: 'zulmy', approvalStatus: 'PENDING_REVIEW', status: 'PENDING_REVIEW',
    matchStatus: 'EXCEPTION', matchError: '3-way match PO: B402689 (PCS) tidak ada di PO', matchCode: 'QTY_MISMATCH',
    total: 11250, subTotal: 11250, ppn: 0, tanggal: now, createdAt: now,
    items: [{ lineId: 'so-garam', kode: 'B402689', satuan: 'PCS', qty: 5, harga: 2250, jumlah: 11250 }],
  });
  const grnGaram = async () => {
    await db.collection('goods_receipts').insertOne({
      id: 'grn-g', tenantId: TID, noGRN: 'GRN-G', noDO: 'DO-13', noPO: 'CPO-81', status: 'POSTED', vendorTenantId: 'zulmy',
      items: [{ lineId: 'so-garam', vendorKode: 'B402689', satuan: 'PCS', qtyReceived: 5, harga: 2250 }],
    });
    await db.collection('customer_purchase_orders').updateOne({ id: 'po-81' }, { $set: { appliedReceiveGrnIds: ['grn-g'] } });
  };
  const admin = { userId: 'u-admin', userName: 'Admin Purchasing', role: 'ADMIN' };
  const garamLine = async () => (await items('po-81')).find((l) => l.lineId === 'so-garam') as Record<string, unknown>;

  it('tambahan di atas batas toleransi → menunggu; tagihan tertahan walau override; Terima manual → MATCHED', async () => {
    await grnGaram();
    await db.collection('hutang').insertOne(hutangGaram('h-pend'));
    await zulmyConfirmed();

    // Nilai PO awal 65.000 → batas 5% = 3.250 < 11.250: tidak lolos auto-terima.
    expect((await garamLine()).vendorLineAcceptance).toMatchObject({ status: 'PENDING', reason: expect.stringContaining('melebihi batas auto-terima') });
    const held = await db.collection('hutang').findOne({ id: 'h-pend' });
    expect(held).toMatchObject({ matchStatus: 'EXCEPTION', matchCode: 'PO_LINE_PENDING_ACCEPTANCE' });
    const blocked = await assertCanApproveInvoice(db, held as never, { overrideMatch: true });
    expect(blocked).toMatchObject({ ok: false });

    const res = await decideVendorLine(db, { tenantId: TID, poId: 'po-81', lineId: 'so-garam', decision: 'ACCEPTED', actor: admin });
    expect(res).toMatchObject({ ok: true });
    expect((await garamLine()).vendorLineAcceptance).toMatchObject({ status: 'ACCEPTED', mode: 'MANUAL', by: admin });
    expect(await db.collection('hutang').findOne({ id: 'h-pend' })).toMatchObject({ matchStatus: 'MATCHED' });
    expect(await db.collection('audit_log').countDocuments({ action: 'CPO_VENDOR_LINE_ACCEPTED', entityId: 'po-81' })).toBe(1);
    expect(await db.collection('integration_outbox').countDocuments({ aggregateId: 'po-81:so-garam' })).toBe(1);

    const again = await decideVendorLine(db, { tenantId: TID, poId: 'po-81', lineId: 'so-garam', decision: 'REJECTED', reason: 'tidak dibutuhkan', actor: admin });
    expect(again).toMatchObject({ ok: false, status: 409, code: 'VENDOR_LINE_DECIDED' });
  });

  it('Tolak: alasan wajib, baris dibatalkan permanen (tidak dipulihkan sinkron SO), tagihan PO_LINE_REJECTED', async () => {
    // Vendor tetap mengirim + menagih; GRN belum diterapkan ke PO saat purchasing menolak.
    await db.collection('goods_receipts').insertOne({
      id: 'grn-r', tenantId: TID, noGRN: 'GRN-R', noDO: 'DO-13', noPO: 'CPO-81', status: 'POSTED', vendorTenantId: 'zulmy',
      items: [{ lineId: 'so-garam', vendorKode: 'B402689', satuan: 'PCS', qtyReceived: 5, harga: 2250 }],
    });
    await db.collection('hutang').insertOne(hutangGaram('h-rej'));
    await zulmyConfirmed();
    expect(await decideVendorLine(db, { tenantId: TID, poId: 'po-81', lineId: 'so-garam', decision: 'REJECTED', reason: 'pendek', actor: admin }))
      .toMatchObject({ ok: false, status: 400 });

    const res = await decideVendorLine(db, {
      tenantId: TID, poId: 'po-81', lineId: 'so-garam', decision: 'REJECTED', reason: 'Tidak ada di menu minggu ini', actor: admin,
    });
    expect(res).toMatchObject({ ok: true });
    expect(await garamLine()).toMatchObject({
      cancelled: true, cancelledSource: 'purchasing_rejected', qtyBackorder: 0,
      vendorLineAcceptance: expect.objectContaining({ status: 'REJECTED', reason: 'Tidak ada di menu minggu ini' }),
    });
    expect(await db.collection('hutang').findOne({ id: 'h-rej' })).toMatchObject({ matchStatus: 'EXCEPTION', matchCode: 'PO_LINE_REJECTED' });
    expect(await db.collection('integration_outbox').findOne({ aggregateId: 'po-81:so-garam' }))
      .toMatchObject({ payload: expect.objectContaining({ decision: 'REJECTED', reason: 'Tidak ada di menu minggu ini' }) });
    expect(await decideVendorLine(db, { tenantId: TID, poId: 'po-81', lineId: 'so-garam', decision: 'ACCEPTED', actor: admin }))
      .toMatchObject({ ok: false, status: 409, code: 'VENDOR_LINE_DECIDED' });

    await zulmyConfirmed();
    const garam = (await items('po-81')).filter((l) => l.kode === 'B402689');
    expect(garam).toHaveLength(1);
    expect(garam[0]).toMatchObject({ cancelled: true, cancelledSource: 'purchasing_rejected' });
    expect((await db.collection('customer_purchase_orders').findOne({ id: 'po-81' }))?.status).not.toBe('PARTIAL_CANCELLED');
  });

  it('Tolak ditolak bila barang sudah diterima', async () => {
    await grnGaram();
    await zulmyConfirmed();
    expect(await decideVendorLine(db, {
      tenantId: TID, poId: 'po-81', lineId: 'so-garam', decision: 'REJECTED', reason: 'Tidak ada di menu minggu ini', actor: admin,
    })).toMatchObject({ ok: false, code: 'VENDOR_LINE_ALREADY_SHIPPED' });
  });

  it('tambahan dalam toleransi PO → diterima otomatis (AUTO_TOLERANCE); auto-terima mati → menunggu', async () => {
    await db.collection('customer_purchase_orders').updateOne({ id: 'po-81' }, { $set: { 'items.1.estimasiHarga': 31250 } });
    await zulmyConfirmed();
    // Nilai PO awal 25.000 + 8 × 31.250 = 275.000 → batas 5% = 13.750 ≥ 11.250.
    expect((await garamLine()).vendorLineAcceptance).toMatchObject({
      status: 'ACCEPTED', mode: 'AUTO_TOLERANCE', rule: expect.objectContaining({ value: 11250, base: 275000, limit: 13750 }),
    });

    await db.collection('customer_purchase_orders').updateOne({ id: 'po-81' }, { $pull: { items: { lineId: 'so-garam' } } as never });
    await db.collection('tenant_settings').insertOne({ tenantId: TID, vendorLineAutoAccept: false });
    await zulmyConfirmed();
    expect((await garamLine()).vendorLineAcceptance).toMatchObject({ status: 'PENDING', reason: 'Auto-terima dinonaktifkan untuk tenant ini' });
  });

  it('SO vendor masih DRAFT tidak menambah baris ke PO; setelah dikonfirmasi baru masuk', async () => {
    const soUpdated = (soStatus: string) => syncCpoFromVendorEvent(db, TID, 'sales_order.updated', {
      customerPoId: 'po-81', noPO: 'CPO-81', salesOrderId: 'so-z', noSO: 'SO-Z', vendorTenantId: 'zulmy', soStatus,
      items: [
        { lineId: 'so-bakso', stokId: 'v-bakso', kode: 'B165667', nama: 'Bakso Sapi Salam', qty: 1, satuan: 'PCS', harga: 25000 },
        { lineId: 'so-garam', stokId: 'v-garam', kode: 'B402689', nama: 'Garam 250g Kapal', qty: 5, satuan: 'PCS', harga: 2250, outsidePo: true },
      ],
    });
    await soUpdated('DRAFT');
    expect((await items('po-81')).some((l) => l.kode === 'B402689')).toBe(false);
    await soUpdated('CONFIRMED');
    expect((await items('po-81')).some((l) => l.kode === 'B402689')).toBe(true);
  });

  it('rekonsiliasi: tambahan vendor lama menunggu + keputusan yang belum terkirim', async () => {
    await zulmyConfirmed();
    await db.collection('customer_purchase_orders').updateOne(
      { id: 'po-81', 'items.lineId': 'so-garam' },
      { $set: { 'items.$.addedAt': new Date(now.getTime() - 25 * 3_600_000) } },
    );
    await db.collection('integration_outbox').insertOne({
      id: 'ob-1', type: 'ENSURE_PUSH_VENDOR_LINE_DECISION', aggregateId: 'po-81:x', tenantId: TID, status: 'FAILED', attempts: 8,
      lastError: 'API key vendor tidak tersedia', updatedAt: new Date(now.getTime() - 3_600_000),
      payload: { poId: 'po-81', noPO: 'CPO-81', lineId: 'x', kode: 'B999', decision: 'REJECTED', vendorTenantId: 'zulmy' },
    });
    const recon = await detectPoVendorLineRecon(db, TID, { now });
    expect(recon.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PO_VENDOR_LINE_PENDING_AGED', refNo: 'CPO-81', kode: 'B402689' }),
      expect.objectContaining({ kind: 'PO_VENDOR_LINE_DECISION_PUSH_STUCK', refNo: 'CPO-81', detail: expect.stringContaining('berhenti otomatis') }),
    ]));
  });
});
