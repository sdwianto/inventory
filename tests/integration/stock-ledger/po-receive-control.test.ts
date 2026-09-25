/**
 * Fase 3.4 — GRN terhadap PO: toleransi lintas satuan (PO DUS, GRN PCS), qtyReceived PO dalam satuan PO,
 * persetujuan lebih-terima tercatat, PO batal menolak penerimaan.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';
import { shortClosePoRemaining } from '@/lib/api/cpo-short-close';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-34';
let seq = 0;

describe.skipIf(!MongoMemoryReplSet)('Fase 3.4 kontrol terima PO', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  const po = (status = 'SENT') => ({
    id: 'po-1', tenantId: TID, noPO: 'PO-34', status,
    items: [{ lineId: 'p1', localStokId: 'mie', kode: 'MIE', qty: 2, satuan: 'DUS', uomId: 'u-dus', qtyReceived: 0 }],
  });

  const receive = (qtyPcs: number, actor: Record<string, unknown> = { userId: 'u1', userName: 'Gudang', role: 'STAFF' }, reason?: string) => {
    seq += 1;
    const grn = {
      id: `grn-${seq}`, tenantId: TID, noGRN: `GRN-34-${seq}`, noDO: `DO-34-${seq}`, noPO: 'PO-34', vendorTenantId: 'v1',
      items: [{
        lineId: `g${seq}`, localStokId: 'mie', vendorKode: 'MIE', qtyOrdered: qtyPcs, qtyBase: qtyPcs,
        satuan: 'PCS', uomId: 'u-pcs', harga: 3000,
      }],
    };
    return applyGrnStockPosting(db, TID, grn as never, [], undefined, actor as never, { overReceiveReason: reason ?? null });
  };

  const poLine = async () => ((await db.collection('customer_purchase_orders').findOne({ id: 'po-1' }))?.items as Array<Record<string, unknown>>)[0];

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('po_receive_control_it');
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });
    await db.collection('products').insertOne({
      id: 'mie', tenantId: TID, kode: 'MIE', nama: 'Mie', satuan: 'PCS', itemRole: 'INGREDIENT', aktif: true,
      syncSource: 'local', gudangKode: 'GKERING', hargaBeli: 3000, stok: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection('product_uom').insertMany([
      { id: 'u-pcs', tenantId: TID, productId: 'mie', satuan: 'PCS', isBase: true, factorToBase: 1, aktif: true, sortOrder: 0 },
      { id: 'u-dus', tenantId: TID, productId: 'mie', satuan: 'DUS', isBase: false, factorToBase: 10, aktif: true, sortOrder: 1 },
    ]);
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  beforeEach(async () => {
    await db.collection('customer_purchase_orders').deleteMany({ tenantId: TID });
    await db.collection('customer_purchase_orders').insertOne(po());
  });

  it('GRN PCS terhadap PO DUS: qtyReceived PO dicatat dalam DUS', async () => {
    const res = await receive(15);
    expect(res.error).toBeUndefined();
    expect(res.overReceive).toBeNull();
    const line = await poLine();
    expect(line.qtyReceived).toBe(1.5);
    expect((await db.collection('customer_purchase_orders').findOne({ id: 'po-1' }))?.status).toBe('PARTIAL_RECEIVED');
  });

  it('lebih terima di atas sisa PO: ditolak tanpa persetujuan; disetujui supervisor tercatat', async () => {
    const blocked = await receive(25);
    expect(blocked.error).toContain('melebihi sisa PO');
    expect((await poLine()).qtyReceived).toBe(0);

    const approved = await receive(25, { userId: 'u-spv', userName: 'Supervisor', role: 'SUPERVISOR' }, 'bonus vendor');
    expect(approved.error).toBeUndefined();
    expect(approved.overReceive).toMatchObject({
      reason: 'bonus vendor',
      approvedBy: { userId: 'u-spv', role: 'SUPERVISOR' },
      lines: [{ kind: 'OVER_QTY', incoming: 25, remaining: 20 }],
    });
    expect((await poLine()).qtyReceived).toBe(2.5);
  });

  it('PO batal menolak penerimaan', async () => {
    await db.collection('customer_purchase_orders').updateOne({ id: 'po-1' }, { $set: { status: 'CANCELLED' } });
    const res = await receive(5);
    expect(res.error).toContain('sudah dibatalkan');
    expect((await poLine()).qtyReceived).toBe(0);
  });

  it('PO disebut tapi tidak ditemukan menolak penerimaan', async () => {
    await db.collection('customer_purchase_orders').deleteMany({ tenantId: TID });
    const res = await receive(5);
    expect(res.error).toContain('tidak ditemukan');
  });

  it('tutup sisa PO: status RECEIVED, GRN berikutnya dihitung lebih-terima, audit tercatat', async () => {
    await db.collection('customer_purchase_orders').updateOne({ id: 'po-1' }, { $set: { status: 'SHIPPED' } });
    await db.collection('customer_purchase_orders').updateOne({ id: 'po-1' }, { $set: { 'items.0.qtyShipped': 2 } });
    expect((await receive(15)).error).toBeUndefined();

    const staff = await shortClosePoRemaining(db, undefined, {
      tenantId: TID, poId: 'po-1', reason: 'vendor habis', actor: { userId: 'u1', userName: 'Gudang', role: 'STAFF' },
    });
    expect(staff).toMatchObject({ ok: false, status: 403 });
    expect(await shortClosePoRemaining(db, undefined, {
      tenantId: TID, poId: 'po-1', reason: 'x', actor: { userId: 'u-spv', userName: 'Spv', role: 'SUPERVISOR' },
    })).toMatchObject({ ok: false, status: 400 });

    const closed = await shortClosePoRemaining(db, undefined, {
      tenantId: TID, poId: 'po-1', reason: 'vendor habis', actor: { userId: 'u-spv', userName: 'Spv', role: 'SUPERVISOR' },
    });
    expect(closed).toMatchObject({ ok: true, status: 'RECEIVED', lines: [{ qtyClosed: 0.5 }] });
    const doc = await db.collection('customer_purchase_orders').findOne({ id: 'po-1' });
    expect(doc?.status).toBe('RECEIVED');
    expect(doc?.shortCloseReason).toBe('vendor habis');
    expect((await poLine()).qtyShortClosed).toBe(0.5);
    expect(await db.collection('audit_log').countDocuments({ tenantId: TID, action: 'CPO_SHORT_CLOSED', entityId: 'po-1' })).toBe(1);

    expect(await shortClosePoRemaining(db, undefined, {
      tenantId: TID, poId: 'po-1', reason: 'lagi', actor: { userId: 'u-spv', userName: 'Spv', role: 'SUPERVISOR' },
    })).toMatchObject({ ok: false, status: 400 });

    const late = await receive(5);
    expect(late.error).toContain('melebihi sisa PO');
  });
});
