/**
 * Fase 3.6 — pembalik GRN lewat dokumen RVS: ajukan → setujui (SoD) → stok & lot keluar,
 * qty PO dikurangi, akrual GRNI dibalik, harga beli rata-rata dikoreksi, cadangan dilepas.
 * Diblokir bila tagihan masih aktif atau lot sudah terpakai.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { postStockMovements } from '@/lib/stock-ledger';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';
import { createJournal } from '@/lib/api/journal';
import { buildGrnAccrualJournalLines } from '@/lib/api/journal-lines';
import { drainEnsureGrnInvoice } from '@/lib/api/integration-outbox';
import { refreshGrnProducts } from '@/lib/api/grn-resolve-products';
import { createGrnFromDelivery } from '@/lib/api/grn-from-webhook';
import {
  approveGrnReversal,
  cancelGrnReversal,
  rejectGrnReversal,
  requestGrnReversal,
} from '@/lib/api/grn-reversal';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-36';
const GUDANG = { userId: 'u-gudang', userName: 'Gudang', role: 'GUDANG' };
const SPV = { userId: 'u-spv', userName: 'Supervisor', role: 'SUPERVISOR' };

describe.skipIf(!MongoMemoryReplSet)('Fase 3.6 pembalik GRN', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;
  let seq = 0;

  const lokasiQty = async () => Number((await db.collection('stok_lokasi').findOne({ tenantId: TID, stokId: 'beras', lokasiKode: 'GKERING' }))?.qty || 0);

  const postGrn = async (qty: number, harga: number, noPO?: string) => {
    seq += 1;
    const grn = {
      id: `grn-${seq}`,
      tenantId: TID,
      noGRN: `GRN-36-${seq}`,
      noDO: `DO-36-${seq}`,
      vendorTenantId: 'v1',
      ...(noPO ? { noPO } : {}),
      items: [{
        lineId: 'l0', localStokId: 'beras', vendorKode: 'BERAS',
        qtyOrdered: qty, qtyBase: qty, satuan: 'KG', harga,
      }],
    };
    const res = await applyGrnStockPosting(db, TID, grn as never, [], undefined, { userId: 'u-terima', userName: 'Penerima' });
    expect(res.error).toBeUndefined();
    await db.collection('goods_receipts').insertOne({
      ...grn,
      status: 'POSTED',
      items: res.itemsFull,
      receivedTotal: res.receivedTotal,
      postedAt: new Date(),
      invoiceSyncStatus: 'SKIPPED',
    });
    await createJournal(db, {
      tanggal: new Date(),
      keterangan: `GRN ${grn.noGRN}`,
      sourceType: 'AUTO_GRN_ACCRUAL',
      sourceId: grn.id,
      userName: 'Penerima',
      tenantId: TID,
      details: buildGrnAccrualJournalLines({ noDoc: grn.noGRN, subTotal: Number(res.receivedTotal) }),
    });
    const lot = await db.collection('ingredient_lots').findOne({ tenantId: TID, grnId: grn.id });
    return { grnId: grn.id, lot: lot as unknown as { id: string; lotNo: string } };
  };

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('grn_reversal_it');
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });
    await db.collection('grn_reversals').createIndex(
      { tenantId: 1, grnId: 1 },
      { unique: true, name: 'uniq_grn_reversal_active', partialFilterExpression: { active: true } },
    );
    await db.collection('products').insertOne({
      id: 'beras', tenantId: TID, kode: 'BERAS', nama: 'Beras', satuan: 'KG',
      itemRole: 'INGREDIENT', aktif: true, syncSource: 'local', gudangKode: 'GKERING',
      hargaBeli: 10000, hargaJual: 12000, stok: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection('product_uom').insertOne({
      id: 'u-beras', tenantId: TID, productId: 'beras', satuan: 'KG',
      isBase: true, factorToBase: 1, aktif: true, sortOrder: 0,
    });
    await db.collection('production_plans').insertOne({ id: 'plan-a', tenantId: TID, noDokumen: 'RPN-A', status: 'IN_PROGRESS' });
    await db.collection('customer_purchase_orders').insertOne({
      id: 'po-1', tenantId: TID, noPO: 'PO-36', productionPlanId: 'plan-a', status: 'SENT',
      items: [{ lineId: 'l0', localStokId: 'beras', kode: 'BERAS', satuan: 'KG', qty: 20, qtyReceived: 0 }],
    });
    await db.collection('tenant_settings').updateOne(
      { tenantId: TID },
      { $set: { 'features.planStockReservation': true } },
      { upsert: true },
    );
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('jalur utama: stok & lot keluar, PO dikurangi, akrual dibalik, harga beli dikoreksi, cadangan dilepas', async () => {
    await postGrn(10, 10000);
    const { grnId, lot } = await postGrn(10, 14000, 'PO-36');
    expect(await lokasiQty()).toBe(20);
    expect((await db.collection('products').findOne({ id: 'beras' }))?.hargaBeli).toBe(12000);
    expect((await db.collection('customer_purchase_orders').findOne({ id: 'po-1' }))?.items[0].qtyReceived).toBe(10);
    expect(await db.collection('stock_allocations').countDocuments({ tenantId: TID, lotId: lot.id, status: 'ACTIVE' })).toBe(1);

    const req = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima DO', actor: GUDANG });
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    expect(req.reversal.noReversal).toMatch(/^RVS/);
    expect((await db.collection('goods_receipts').findOne({ id: grnId }))?.reversalPendingId).toBe(req.reversal.id);

    const dup = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'dobel', actor: GUDANG });
    expect(dup.ok).toBe(false);

    const self = await approveGrnReversal(db, { tenantId: TID, reversalId: req.reversal.id, actor: { ...GUDANG, role: 'SUPERVISOR' } });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.status).toBe(403);

    const approved = await approveGrnReversal(db, { tenantId: TID, reversalId: req.reversal.id, actor: SPV });
    expect(approved.ok).toBe(true);

    expect(await lokasiQty()).toBe(10);
    const lotAfter = await db.collection('ingredient_lots').findOne({ id: lot.id });
    expect(lotAfter?.qtyRemaining).toBe(0);
    expect(lotAfter?.reversedBy?.reversalId).toBe(req.reversal.id);
    const kartu = await db.collection('stok_kartu').findOne({ tenantId: TID, sourceType: 'GRN_REVERSAL', sourceId: req.reversal.id });
    expect(kartu?.keluar).toBe(10);
    expect(kartu?.hargaSatuan).toBe(14000);

    const prod = await db.collection('products').findOne({ id: 'beras' });
    expect(prod?.hargaBeli).toBe(10000);

    const po = await db.collection('customer_purchase_orders').findOne({ id: 'po-1' });
    expect(po?.items[0].qtyReceived).toBe(0);
    expect(po?.appliedReverseGrnIds).toContain(grnId);

    const accrual = await db.collection('jurnal').findOne({ tenantId: TID, sourceType: 'AUTO_GRN_ACCRUAL', sourceId: grnId });
    const rev = await db.collection('jurnal').findOne({ tenantId: TID, sourceType: 'AUTO_GRN_ACCRUAL_REVERSAL', sourceId: grnId });
    expect(rev?.totalDebet).toBe(accrual?.totalDebet);
    expect(rev?.details[0].kredit).toBe(accrual?.details[0].debet);

    const alloc = await db.collection('stock_allocations').findOne({ tenantId: TID, lotId: lot.id });
    expect(alloc?.status).toBe('RELEASED');
    expect(alloc?.releasedReason).toBe('GRN_REVERSED');

    const grn = await db.collection('goods_receipts').findOne({ id: grnId });
    expect(grn?.status).toBe('REVERSED');
    expect(grn?.reversalPendingId).toBeUndefined();
    expect(grn?.reversedBy?.noReversal).toBe(req.reversal.noReversal);
    expect(grn?.invoiceSyncStatus).toBe('SKIPPED');

    const again = await approveGrnReversal(db, { tenantId: TID, reversalId: req.reversal.id, actor: SPV });
    expect(again.ok && again.alreadyPosted).toBe(true);
    expect(await lokasiQty()).toBe(10);
    expect(await db.collection('stok_kartu').countDocuments({ tenantId: TID, sourceType: 'GRN_REVERSAL' })).toBe(1);

    const reRequest = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'lagi', actor: GUDANG });
    expect(reRequest.ok).toBe(false);
  });

  it('tagihan aktif memblokir pengajuan; setelah ditolak bisa diajukan', async () => {
    const { grnId } = await postGrn(3, 10000);
    const bare = await postGrn(1, 10000);
    await db.collection('goods_receipts').updateOne({ id: bare.grnId }, { $set: { noInvoice: 'INV-0', vendorInvoiceId: 'vi-0' } });
    const noHutang = await requestGrnReversal(db, { tenantId: TID, grnId: bare.grnId, reason: 'Salah terima', actor: GUDANG });
    expect(noHutang.ok).toBe(false);
    if (!noHutang.ok) expect(noHutang.error).toContain('belum masuk menu Hutang');

    await db.collection('goods_receipts').updateOne({ id: grnId }, { $set: { noInvoice: 'INV-1', vendorInvoiceId: 'vi-1', hutangId: 'h-1' } });
    await db.collection('hutang').insertOne({ id: 'h-1', tenantId: TID, grnId, noInvoice: 'INV-1', approvalStatus: 'PENDING' });
    const blocked = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain('Tolak tagihan di menu Hutang');

    await db.collection('hutang').updateOne({ id: 'h-1' }, { $set: { approvalStatus: 'REJECTED', status: 'REJECTED' } });
    const req = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(req.ok).toBe(true);
  });

  it('lot yang sudah terpakai memblokir pengajuan', async () => {
    const { grnId, lot } = await postGrn(4, 10000);
    const used = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'RELEASE', sourceId: 'rl-36-a', noTransaksi: 'RL-36-A', keterangan: 'uji',
      lines: [{
        lineRef: '1', productId: 'beras', warehouseKode: 'GKERING', deltaQtyBase: -1,
        lotPolicy: { mode: 'FEFO_CONSUME', preferredLotNo: lot.lotNo },
      }],
    });
    expect(used.ok).toBe(true);
    const res = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('sudah terpakai');
  });

  it('lot terpakai setelah pengajuan: persetujuan gagal tanpa efek samping', async () => {
    const { grnId, lot } = await postGrn(5, 10000);
    const req = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'RELEASE', sourceId: 'rl-36-b', noTransaksi: 'RL-36-B', keterangan: 'uji',
      lines: [{
        lineRef: '1', productId: 'beras', warehouseKode: 'GKERING', deltaQtyBase: -2,
        lotPolicy: { mode: 'FEFO_CONSUME', preferredLotNo: lot.lotNo },
      }],
    });
    const before = await lokasiQty();
    const res = await approveGrnReversal(db, { tenantId: TID, reversalId: req.reversal.id, actor: SPV });
    expect(res.ok).toBe(false);
    expect(await lokasiQty()).toBe(before);
    expect((await db.collection('grn_reversals').findOne({ id: req.reversal.id }))?.status).toBe('PENDING_APPROVAL');
    expect((await db.collection('goods_receipts').findOne({ id: grnId }))?.status).toBe('POSTED');

    const rejected = await rejectGrnReversal(db, { tenantId: TID, reversalId: req.reversal.id, reason: 'Lot sudah dipakai', actor: SPV });
    expect(rejected.ok).toBe(true);
    const grn = await db.collection('goods_receipts').findOne({ id: grnId });
    expect(grn?.reversalPendingId).toBeUndefined();
  });

  it('lot karantina QC ikut dibalik', async () => {
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { 'features.lotQcRequired': true } });
    const { grnId, lot } = await postGrn(3, 10000);
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { 'features.lotQcRequired': false } });
    expect((await db.collection('ingredient_lots').findOne({ id: lot.id }))?.qcStatus).toBe('QUARANTINE');
    const req = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const res = await approveGrnReversal(db, { tenantId: TID, reversalId: req.reversal.id, actor: SPV });
    expect(res.ok).toBe(true);
    expect((await db.collection('ingredient_lots').findOne({ id: lot.id }))?.qtyRemaining).toBe(0);
  });

  it('lot lolos QC bisa dibalik walau ada lot lain karantina di produk & gudang yang sama', async () => {
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { 'features.lotQcRequired': true } });
    const held = await postGrn(2, 10000);
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { 'features.lotQcRequired': false } });
    expect((await db.collection('ingredient_lots').findOne({ id: held.lot.id }))?.qcStatus).toBe('QUARANTINE');
    const { grnId, lot } = await postGrn(3, 10000);
    const req = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const res = await approveGrnReversal(db, { tenantId: TID, reversalId: req.reversal.id, actor: SPV });
    expect(res.ok).toBe(true);
    expect((await db.collection('ingredient_lots').findOne({ id: lot.id }))?.qtyRemaining).toBe(0);
    expect((await db.collection('ingredient_lots').findOne({ id: held.lot.id }))?.qtyRemaining).toBe(2);
  });

  it('retur vendor pada GRN memblokir pengajuan', async () => {
    const { grnId } = await postGrn(2, 10000);
    await db.collection('vendor_returns').insertOne({ id: 'rtv-1', tenantId: TID, grnId, noReturn: 'RTV-1', status: 'DRAFT' });
    const res = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('retur vendor');
  });

  it('PO lama tanpa jejak per GRN memblokir pengajuan', async () => {
    await db.collection('customer_purchase_orders').insertOne({
      id: 'po-legacy', tenantId: TID, noPO: 'PO-LEGACY', status: 'RECEIVED',
      items: [{ lineId: 'lx', localStokId: 'x', qty: 1, qtyReceived: 1 }],
    });
    const { grnId } = await postGrn(2, 10000);
    await db.collection('goods_receipts').updateOne({ id: grnId }, { $set: { noPO: 'PO-LEGACY' } });
    const res = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('data lama');
  });

  it('WR maintenance yang ditutup otomatis oleh GRN dibuka lagi', async () => {
    await db.collection('customer_purchase_orders').insertOne({
      id: 'po-wr', tenantId: TID, noPO: 'PO-WR', status: 'SENT', maintenanceRequestId: 'wr-1',
      items: [{ lineId: 'l0', localStokId: 'beras', kode: 'BERAS', satuan: 'KG', qty: 2, qtyReceived: 0 }],
    });
    const { grnId } = await postGrn(2, 10000, 'PO-WR');
    await db.collection('maintenance_requests').insertOne({
      id: 'wr-1', tenantId: TID, noWR: 'WR-1', status: 'CLOSED', autoClosedBy: 'GRN', linkedGrnId: grnId,
      linkedGrnNo: 'x', closedAt: new Date(), catatanPenyelesaian: `Otomatis: GRN GRN-36-${seq} diposting (PO PO-WR)`,
    });
    const req = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const res = await approveGrnReversal(db, { tenantId: TID, reversalId: req.reversal.id, actor: SPV });
    expect(res.ok).toBe(true);
    const wr = await db.collection('maintenance_requests').findOne({ id: 'wr-1' });
    expect(wr?.status).toBe('IN_PROGRESS');
    expect(wr?.linkedGrnId).toBeUndefined();
    expect(wr?.catatanPenyelesaian).toBeUndefined();
    expect(wr?.reopenReason).toContain(req.reversal.noReversal);
  });

  it('produk GRN yang sudah di-merge tetap bisa dibalik (lot di produk kanonik)', async () => {
    await db.collection('products').insertOne({ id: 'beras-lama', tenantId: TID, kode: 'BERAS-L', nama: 'Beras lama', mergedInto: 'beras' });
    const { grnId } = await postGrn(2, 10000);
    await db.collection('goods_receipts').updateOne({ id: grnId }, { $set: { 'items.0.stockProductId': 'beras-lama' } });
    const res = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(res.ok).toBe(true);
  });

  it('GRN REVERSED terkunci: detail/webhook tidak mengembalikannya ke DRAFT; faktur ditunda saat pengajuan aktif', async () => {
    const { grnId } = await postGrn(2, 10000);
    await db.collection('goods_receipts').updateOne({ id: grnId }, { $set: { vendorDeliveryId: 'dlv-rev' } });
    const req = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(req.ok).toBe(true);
    if (!req.ok) return;

    const drained = await drainEnsureGrnInvoice(db, { tenantId: TID, grnId });
    expect(drained.invoiceSync.code).toBe('GRN_REVERSAL_PENDING');
    const outbox = await db.collection('integration_outbox').findOne({ aggregateId: grnId });
    expect(outbox?.status).toBe('FAILED');
    expect(outbox?.attempts).toBe(0);

    const res = await approveGrnReversal(db, { tenantId: TID, reversalId: req.reversal.id, actor: SPV });
    expect(res.ok).toBe(true);
    const grn = await db.collection('goods_receipts').findOne({ id: grnId });
    const refreshed = await refreshGrnProducts(db, { ...grn, items: [{ lineId: 'l0', vendorKode: 'BERAS' }] } as never);
    expect(refreshed.status).toBe('REVERSED');
    await createGrnFromDelivery(db, TID, { deliveryId: 'dlv-rev', noDO: grn?.noDO, items: [] }, 'v1');
    const after = await db.collection('goods_receipts').findOne({ id: grnId });
    expect(after?.status).toBe('REVERSED');
    expect(after?.items).toHaveLength(1);

    const skipped = await drainEnsureGrnInvoice(db, { tenantId: TID, grnId });
    expect(skipped.invoiceSync.reason).toBe('grn_reversed');
  });

  it('batal hanya oleh pengaju; setelah batal GRN bisa diajukan lagi', async () => {
    const { grnId } = await postGrn(2, 10000);
    const req = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const other = await cancelGrnReversal(db, { tenantId: TID, reversalId: req.reversal.id, actor: { userId: 'u-lain', role: 'GUDANG' } });
    expect(other.ok).toBe(false);
    const cancelled = await cancelGrnReversal(db, { tenantId: TID, reversalId: req.reversal.id, actor: GUDANG });
    expect(cancelled.ok).toBe(true);
    const again = await requestGrnReversal(db, { tenantId: TID, grnId, reason: 'Salah terima', actor: GUDANG });
    expect(again.ok).toBe(true);
  });
});
