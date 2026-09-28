/**
 * Approve tagihan vendor pada PO multi-pengiriman (PARTIAL_RECEIVED) — 3-way match asli, Mongo replica set.
 * Bentuk data meniru INV2609000021 / CPO2609000048: baris yang ditagih sudah diterima penuh,
 * harga invoice ≠ harga PO/SO → EXCEPTION; override harus bisa dipakai.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { HutangDoc } from '@/types/documents';

const { assertCanApproveInvoice, enrichHutangDetail } = await import('@/lib/api/hutang-approval');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };
let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-hutang-partial';

describe.skipIf(!MongoMemoryReplSet)('Approve tagihan pada PO PARTIAL_RECEIVED (Mongo replica set)', { timeout: 90_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  const alufoilInvoice = (overrides: Record<string, unknown> = {}): HutangDoc => ({
    id: 'h-alu',
    tenantId: TID,
    referenceType: 'VENDOR_INVOICE',
    noHutang: 'HT-ALU',
    noInvoice: 'INV-ALU',
    vendorInvoiceId: 'vinv-alu',
    noPO: 'CPO-P',
    noDO: 'DO-ALU',
    noSO: 'SO-P',
    vendorTenantId: 'v1',
    approvalStatus: 'PENDING_REVIEW',
    status: 'PENDING_REVIEW',
    matchStatus: 'EXCEPTION',
    matchError: '3-way match harga: B582948 invoice Rp 750 > harga PO/SO Rp 575 (+2%)',
    total: 1_012_500,
    subTotal: 1_012_500,
    items: [{ lineId: 'grn-alu-l1', kode: 'B582948', nama: 'Alumunium Foil Persegi', satuan: 'PCS', qty: 1350, harga: 750 }],
    ...overrides,
  } as HutangDoc);

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('hutang_partial_po_it');
  });

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  beforeEach(async () => {
    for (const c of ['customer_purchase_orders', 'goods_receipts', 'hutang', 'vendor_returns', 'tenant_settings']) {
      await db.collection(c).deleteMany({});
    }
    await db.collection('customer_purchase_orders').insertOne({
      id: 'po-p',
      tenantId: TID,
      noPO: 'CPO-P',
      status: 'PARTIAL_RECEIVED',
      vendorTenantId: 'v1',
      vendorSoSnapshot: { noSO: 'SO-P', items: [{ kode: 'B582948', satuan: 'PCS', qty: 1350, harga: 575 }] },
      items: [
        { lineId: 'po-alu', kode: 'B582948', vendorKode: 'B582948', satuan: 'PCS', qty: 1350, qtyShipped: 1350, qtyReceived: 1350 },
        { lineId: 'po-beras', kode: 'B335256-KG', vendorKode: 'B335256-KG', satuan: 'SAK', qty: 3, qtyShipped: 3, qtyReceived: 3 },
        { lineId: 'po-telur', kode: 'B051235', vendorKode: 'B051235', satuan: 'PCS', qty: 1363, qtyShipped: 0, qtyReceived: 0 },
        { lineId: 'po-wortel', kode: 'B590352', vendorKode: 'B590352', satuan: 'KG', qty: 34, qtyShipped: 0, qtyReceived: 0 },
      ],
    });
    await db.collection('goods_receipts').insertMany([
      {
        id: 'grn-alu', tenantId: TID, noGRN: 'GRN-ALU', noDO: 'DO-ALU', noPO: 'CPO-P', status: 'POSTED', vendorTenantId: 'v1',
        items: [{ lineId: 'grn-alu-l1', vendorKode: 'B582948', satuan: 'PCS', qtyReceived: 1350, harga: 750 }],
      },
      {
        id: 'grn-beras', tenantId: TID, noGRN: 'GRN-BERAS', noDO: 'DO-BERAS', noPO: 'CPO-P', status: 'POSTED', vendorTenantId: 'v1',
        items: [{ lineId: 'grn-beras-l1', vendorKode: 'B335256-KG', satuan: 'SAK', qtyReceived: 3, harga: 395000 }],
      },
    ]);
    await db.collection('hutang').insertMany([
      {
        id: 'h-beras', tenantId: TID, referenceType: 'VENDOR_INVOICE', noInvoice: 'INV-BERAS', noPO: 'CPO-P', noDO: 'DO-BERAS',
        vendorTenantId: 'v1', approvalStatus: 'APPROVED', matchStatus: 'MATCHED',
        items: [{ lineId: 'grn-beras-l1', kode: 'B335256-KG', satuan: 'SAK', qty: 3, harga: 395000 }],
      },
      alufoilInvoice(),
    ]);
  });

  it('EXCEPTION harga + override → lolos; tanpa override → MATCH_EXCEPTION', async () => {
    const withOverride = await assertCanApproveInvoice(db, alufoilInvoice(), { overrideMatch: true });
    expect(withOverride).toEqual({ ok: true });

    const noOverride = await assertCanApproveInvoice(db, alufoilInvoice());
    expect(noOverride).toMatchObject({ ok: false, code: 'MATCH_EXCEPTION' });
  });

  it('detail: canApprove true (UI konsisten dengan API)', async () => {
    const detail = await enrichHutangDetail(db, alufoilInvoice());
    expect(detail.canApprove).toBe(true);
    expect(detail.po?.poReceived).toBe(false);
  });

  it('qty ditagih melebihi GRN → PO_NOT_RECEIVED walau override', async () => {
    const over = alufoilInvoice({
      items: [{ lineId: 'grn-alu-l1', kode: 'B582948', satuan: 'PCS', qty: 1500, harga: 750 }],
    });
    const res = await assertCanApproveInvoice(db, over, { overrideMatch: true });
    expect(res).toMatchObject({ ok: false, code: 'PO_NOT_RECEIVED' });
    expect((res as { error?: string }).error).toMatch(/GRN posted 1350/);
    expect((await enrichHutangDetail(db, over)).canApprove).toBe(false);
  });

  it('GRN belum POSTED untuk DO yang ditagih → PO_NOT_RECEIVED', async () => {
    await db.collection('goods_receipts').updateOne({ id: 'grn-alu' }, { $set: { status: 'DRAFT' } });
    const res = await assertCanApproveInvoice(db, alufoilInvoice(), { overrideMatch: true });
    expect(res).toMatchObject({ ok: false, code: 'PO_NOT_RECEIVED' });
  });

  it('baris yang sama sudah ditagih invoice lain → PO_NOT_RECEIVED (cegah tagihan ganda)', async () => {
    await db.collection('hutang').insertOne({
      id: 'h-alu-dup', tenantId: TID, referenceType: 'VENDOR_INVOICE', noInvoice: 'INV-ALU-DUP', noPO: 'CPO-P', noDO: 'DO-ALU',
      vendorTenantId: 'v1', approvalStatus: 'APPROVED', matchStatus: 'MATCHED',
      items: [{ lineId: 'grn-alu-l1', kode: 'B582948', satuan: 'PCS', qty: 1350, harga: 750 }],
    });
    const res = await assertCanApproveInvoice(db, alufoilInvoice(), { overrideMatch: true });
    expect(res).toMatchObject({ ok: false, code: 'PO_NOT_RECEIVED' });
    expect((res as { error?: string }).error).toMatch(/sudah ditagih/);
  });

  it('tagihan MATCHED pada PO PARTIAL_RECEIVED tetap lolos (perilaku lama)', async () => {
    const matched = alufoilInvoice({ matchStatus: 'MATCHED', matchError: null });
    expect(await assertCanApproveInvoice(db, matched)).toEqual({ ok: true });
  });
});
