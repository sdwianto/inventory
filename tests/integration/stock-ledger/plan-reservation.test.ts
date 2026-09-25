/**
 * Fase 3.3 — cadangan stok rencana (flag planStockReservation).
 * GRN dari PO rencana mengunci lot. RL rencana lain ditolak. Rencana pemilik
 * dan override beralasan (disetujui) boleh memakai. Selesai/batal melepas sisa.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { postStockMovements } from '@/lib/stock-ledger';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';
import { applyAllocationRestore, capActiveAllocationTo, releasePlanReservations } from '@/lib/stock-ledger/plan-reservation';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-33';

describe.skipIf(!MongoMemoryReplSet)('Fase 3.3 cadangan stok rencana', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;
  let seq = 0;

  const setFlag = (on: boolean) => db.collection('tenant_settings').updateOne(
    { tenantId: TID },
    { $set: { 'features.planStockReservation': on } },
    { upsert: true },
  );

  const receive = async (qty: number, noPO?: string) => {
    seq += 1;
    const grn = {
      id: `grn-${seq}`,
      tenantId: TID,
      noGRN: `GRN-33-${seq}`,
      noDO: `DO-33-${seq}`,
      vendorTenantId: 'v1',
      ...(noPO ? { noPO } : {}),
      items: [{
        lineId: 'l0', localStokId: 'beras', vendorKode: 'BERAS',
        qtyOrdered: qty, qtyBase: qty, satuan: 'KG', harga: 10000,
      }],
    };
    const res = await applyGrnStockPosting(db, TID, grn as never, [], undefined, { userId: 'u1', userName: 'Penerima' });
    expect(res.error).toBeUndefined();
    const lot = await db.collection('ingredient_lots').findOne({ tenantId: TID, grnId: grn.id });
    return lot as { id: string; lotNo: string; qtyRemaining: number };
  };

  const issue = (qty: number, policy: Record<string, unknown> = { mode: 'FEFO_CONSUME' }) => {
    seq += 1;
    return postStockMovements(db, undefined, {
      tenantId: TID,
      sourceType: 'RELEASE',
      sourceId: `rl-${seq}`,
      noTransaksi: `RL-33-${seq}`,
      keterangan: 'uji cadangan',
      lines: [{
        lineRef: '1',
        productId: 'beras',
        warehouseKode: 'GKERING',
        deltaQtyBase: -qty,
        lotPolicy: policy,
      }],
    });
  };

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('plan_reservation_it');
    await db.collection('stok_lokasi').createIndex(
      { tenantId: 1, stokId: 1, lokasiKode: 1 },
      { unique: true, name: 'uniq_stok_lokasi' },
    );
    await db.collection('products').insertOne({
      id: 'beras', tenantId: TID, kode: 'BERAS', nama: 'Beras', satuan: 'KG',
      itemRole: 'INGREDIENT', aktif: true, syncSource: 'local', gudangKode: 'GKERING',
      hargaBeli: 10000, stok: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection('product_uom').insertOne({
      id: 'u-beras', tenantId: TID, productId: 'beras', satuan: 'KG',
      isBase: true, factorToBase: 1, aktif: true, sortOrder: 0,
    });
    await db.collection('production_plans').insertMany([
      { id: 'plan-a', tenantId: TID, noDokumen: 'RPN-A', status: 'IN_PROGRESS' },
      { id: 'plan-b', tenantId: TID, noDokumen: 'RPN-B', status: 'IN_PROGRESS' },
    ]);
    await db.collection('customer_purchase_orders').insertOne({
      id: 'po-a', tenantId: TID, noPO: 'PO-A', productionPlanId: 'plan-a', status: 'RECEIVED',
    });
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('flag mati: GRN dari PO rencana tidak mengunci lot', async () => {
    await setFlag(false);
    const lot = await receive(4, 'PO-A');
    expect(await db.collection('stock_allocations').countDocuments({ tenantId: TID, lotId: lot.id })).toBe(0);
    const res = await issue(4);
    expect(res.ok).toBe(true);
  });

  it('flag hidup: lot terkunci untuk rencana pemilik; rencana lain ditolak; pemilik menghabiskan cadangan', async () => {
    await setFlag(true);
    const free = await receive(3);
    const locked = await receive(5, 'PO-A');
    const alloc = await db.collection('stock_allocations').findOne({ tenantId: TID, lotId: locked.id, status: 'ACTIVE' });
    expect(alloc?.productionPlanId).toBe('plan-a');
    expect(alloc?.qtyRemaining).toBe(5);

    const other = await issue(4, { mode: 'FEFO_CONSUME', reservationPlanId: 'plan-b' });
    expect(other.ok).toBe(false);
    expect(other.error).toContain('cadangan rencana lain');

    const ownFree = await issue(3, { mode: 'FEFO_CONSUME', reservationPlanId: 'plan-b' });
    expect(ownFree.ok).toBe(true);
    expect((await db.collection('ingredient_lots').findOne({ id: free.id }))?.qtyRemaining).toBe(0);
    expect((await db.collection('ingredient_lots').findOne({ id: locked.id }))?.qtyRemaining).toBe(5);

    const owner = await issue(5, { mode: 'FEFO_CONSUME', reservationPlanId: 'plan-a' });
    expect(owner.ok).toBe(true);
    const after = await db.collection('stock_allocations').findOne({ tenantId: TID, lotId: locked.id });
    expect(after?.status).toBe('CONSUMED');
    expect(after?.qtyRemaining).toBe(0);
  });

  it('override yang disetujui mengambil cadangan rencana lain, lalu batal melepas sisa', async () => {
    await setFlag(true);
    const locked = await receive(4, 'PO-A');
    const blocked = await issue(2);
    expect(blocked.ok).toBe(false);

    const overridden = await issue(2, { mode: 'FEFO_CONSUME', reservationOverride: true });
    expect(overridden.ok).toBe(true);
    const partial = await db.collection('stock_allocations').findOne({ tenantId: TID, lotId: locked.id });
    expect(partial?.status).toBe('ACTIVE');
    expect(partial?.qtyRemaining).toBe(2);

    const released = await releasePlanReservations(db, undefined, {
      tenantId: TID, productionPlanId: 'plan-a', reason: 'PLAN_CANCELLED',
    });
    expect(released).toBeGreaterThan(0);
    const opened = await issue(2);
    expect(opened.ok).toBe(true);
  });

  it('tolak sebagian mengecilkan cadangan ke qty yang lolos', async () => {
    await setFlag(true);
    const locked = await receive(6, 'PO-A');
    await capActiveAllocationTo(db, undefined, { tenantId: TID, lotId: locked.id, qty: 2 });
    const alloc = await db.collection('stock_allocations').findOne({ tenantId: TID, lotId: locked.id });
    expect(alloc?.status).toBe('ACTIVE');
    expect(alloc?.qtyRemaining).toBe(2);
    const other = await issue(5, { mode: 'FEFO_CONSUME', reservationPlanId: 'plan-b' });
    expect(other.ok).toBe(false);
    // Sisa lot di atas qty cadangan adalah stok bebas: rencana lain boleh ambil, cadangan tetap utuh.
    const otherFree = await issue(4, { mode: 'FEFO_CONSUME', reservationPlanId: 'plan-b' });
    expect(otherFree.ok).toBe(true);
    if (otherFree.ok) expect(otherFree.lines[0].lot?.shortfall ?? 0).toBe(0);
    expect((await db.collection('ingredient_lots').findOne({ id: locked.id }))?.qtyRemaining).toBe(2);
    expect((await db.collection('stock_allocations').findOne({ tenantId: TID, lotId: locked.id }))?.qtyRemaining).toBe(2);
    const owner = await issue(2, { mode: 'FEFO_CONSUME', reservationPlanId: 'plan-a' });
    expect(owner.ok).toBe(true);
  });

  it('QC tolak penuh melepas cadangan dengan alasan QC_REJECTED', async () => {
    await setFlag(true);
    const locked = await receive(3, 'PO-A');
    await capActiveAllocationTo(db, undefined, { tenantId: TID, lotId: locked.id, qty: 0 });
    const alloc = await db.collection('stock_allocations').findOne({ tenantId: TID, lotId: locked.id });
    expect(alloc).toMatchObject({ status: 'RELEASED', releasedReason: 'QC_REJECTED', qtyRemaining: 0, qtyQcRejected: 3 });
    expect((await issue(3, { mode: 'FEFO_CONSUME', reservationPlanId: 'plan-b' })).ok).toBe(true);
  });

  it('rencana sudah selesai: GRN tidak membuat cadangan; restore tidak membuka cadangan rencana tertutup', async () => {
    await setFlag(true);
    await db.collection('production_plans').insertOne({ id: 'plan-c', tenantId: TID, noDokumen: 'RPN-C', status: 'APPROVED' });
    await db.collection('customer_purchase_orders').insertOne({
      id: 'po-c', tenantId: TID, noPO: 'PO-C', productionPlanId: 'plan-c', status: 'RECEIVED',
    });
    const lot = await receive(2, 'PO-C');
    expect((await db.collection('production_plans').findOne({ id: 'plan-c' }))?.reservationSeq).toBe(1);
    expect((await issue(2, { mode: 'FEFO_CONSUME', reservationPlanId: 'plan-c' })).ok).toBe(true);
    expect((await db.collection('stock_allocations').findOne({ tenantId: TID, lotId: lot.id }))?.status).toBe('CONSUMED');

    await db.collection('production_plans').updateOne({ id: 'plan-c' }, { $set: { status: 'COMPLETED' } });
    await applyAllocationRestore(db, undefined, { tenantId: TID, takes: [{ lotId: lot.id, qty: 2 }], at: new Date() });
    expect((await db.collection('stock_allocations').findOne({ tenantId: TID, lotId: lot.id }))?.status).toBe('CONSUMED');

    const late = await receive(2, 'PO-C');
    expect(await db.collection('stock_allocations').countDocuments({ tenantId: TID, lotId: late.id })).toBe(0);
    expect((await issue(2, { mode: 'FEFO_CONSUME', reservationPlanId: 'plan-b' })).ok).toBe(true);
  });
});
