/**
 * Fase 1.1 — acuan bahan per rencana (PO rencana + MRP, dikurangi RL) pada Mongo replica set.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import {
  loadPlanReference,
  planReferenceReadiness,
  qtyToProductBase,
} from '@/lib/food-production/plan-reference';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-11';
const scope = { tenantId: TID, role: 'ADMIN' } as AuthContext;
const PLAN = { id: 'plan-1', tenantId: TID, tanggal: '2026-09-20', kitchenId: 'k1' };

function uom(productId: string, satuan: string, factorToBase: number, isBase = false) {
  return { id: `${productId}-${satuan}`, tenantId: TID, productId, satuan, factorToBase, isBase, aktif: true, sortOrder: isBase ? 0 : 1 };
}

describe('qtyToProductBase', () => {
  const uoms = [uom('g', 'KG', 1, true), uom('g', 'DUS', 12)] as never[];
  it('mengonversi satuan kemasan lewat product_uom', () => {
    expect(qtyToProductBase({ qty: 1.5, satuan: 'DUS' }, uoms)).toMatchObject({ qtyBase: 18, converted: true });
  });
  it('mengonversi satu keluarga satuan ke satuan dasar', () => {
    expect(qtyToProductBase({ qty: 4000, satuan: 'GR' }, [], 'KG')).toMatchObject({ qtyBase: 4, converted: true });
  });
  it('menandai satuan yang tidak bisa dikonversi', () => {
    expect(qtyToProductBase({ qty: 3, satuan: 'IKAT' }, [], 'KG')).toMatchObject({ qtyBase: 3, converted: false });
  });
});

describe.skipIf(!MongoMemoryReplSet)('loadPlanReference (Mongo replica set)', { timeout: 60_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('plan_reference_it');

    const product = (id: string, kode: string, nama: string, satuan: string, extra: Record<string, unknown> = {}) => ({
      id, tenantId: TID, kode, nama, satuan, aktif: true, gudangKode: 'GKERING', ...extra,
    });
    await db.collection('products').insertMany([
      product('gula', 'GL01', 'Gula', 'KG', { masterProductId: 'm-gula' }),
      product('gula-lama', 'GL01', 'Gula', 'KG', { aktif: false, masterProductId: 'm-gula' }),
      product('gula-b', 'GL01', 'Gula', 'KG'),
      product('telur', 'TL01', 'Telur', 'KG'),
      product('minyak', 'MY01', 'Minyak', 'LTR'),
      product('daun', 'DN01', 'Daun Pandan', 'KG'),
      product('garam', 'GR01', 'Garam', 'KG'),
      product('garam-pak', 'GR01', 'Garam', 'PAK'),
    ]);
    await db.collection('product_uom').insertMany([
      uom('gula', 'KG', 1, true),
      uom('gula', 'DUS', 12),
      uom('gula-b', 'KG', 1, true),
      uom('telur', 'KG', 1, true),
      uom('minyak', 'LTR', 1, true),
      uom('daun', 'KG', 1, true),
      uom('garam', 'KG', 1, true),
      uom('garam-pak', 'PAK', 1, true),
    ]);
    await db.collection('stok_lokasi').insertMany([
      { tenantId: TID, stokId: 'gula', lokasiKode: 'GKERING', qty: 7 },
      { tenantId: TID, stokId: 'gula-lama', lokasiKode: 'GKERING', qty: 2 },
      { tenantId: TID, stokId: 'gula-b', lokasiKode: 'GKERING', qty: 1 },
      { tenantId: TID, stokId: 'minyak', lokasiKode: 'GKERING', qty: 2 },
    ]);

    await db.collection('customer_purchase_orders').insertMany([
      {
        id: 'po-1', tenantId: TID, noPO: 'CPO-1', productionPlanId: PLAN.id, status: 'RECEIVED', createdAt: new Date(1),
        items: [
          { localStokId: 'gula-lama', kode: 'GL01', satuan: 'DUS', qty: 2, qtyReceived: 1.5 },
          { localStokId: 'telur', kode: 'TL01', satuan: 'GR', qty: 5000, qtyReceived: 4000 },
          { localStokId: 'daun', kode: 'DN01', satuan: 'IKAT', qty: 3, qtyReceived: 3 },
        ],
      },
      {
        id: 'po-2', tenantId: TID, noPO: 'CPO-2', productionPlanId: PLAN.id, status: 'CONFIRMED', createdAt: new Date(2),
        items: [
          { localStokId: 'gula', kode: 'GL01', satuan: 'KG', qty: 6, qtyReceived: 6 },
          { localStokId: 'minyak', kode: 'MY01', satuan: 'LTR', qty: 10, qtyReceived: 0, cancelled: true },
        ],
      },
      {
        id: 'po-draft', tenantId: TID, noPO: 'CPO-3', productionPlanId: PLAN.id, status: 'DRAFT', createdAt: new Date(3),
        items: [{ localStokId: 'minyak', kode: 'MY01', satuan: 'LTR', qty: 10, qtyReceived: 0 }],
      },
      {
        id: 'po-batal', tenantId: TID, noPO: 'CPO-4', productionPlanId: PLAN.id, status: 'CANCELLED', createdAt: new Date(4),
        items: [{ localStokId: 'minyak', kode: 'MY01', satuan: 'LTR', qty: 10, qtyReceived: 10 }],
      },
      {
        id: 'po-lain', tenantId: TID, noPO: 'CPO-5', productionPlanId: 'plan-lain', status: 'RECEIVED', createdAt: new Date(5),
        items: [{ localStokId: 'minyak', kode: 'MY01', satuan: 'LTR', qty: 10, qtyReceived: 10 }],
      },
    ]);

    await db.collection('material_requirements').insertMany([
      {
        id: 'mrp-lama', tenantId: TID, productionPlanId: PLAN.id, status: 'CANCELLED', createdAt: new Date(10),
        lines: [{ productId: 'minyak', satuan: 'LTR', qtyGross: 99 }],
      },
      {
        id: 'mrp-1', tenantId: TID, productionPlanId: PLAN.id, status: 'APPROVED', createdAt: new Date(9),
        lines: [
          { productId: 'gula', productNama: 'Gula', satuan: 'KG', qtyGross: 20 },
          { productId: 'telur', productNama: 'Telur', satuan: 'KG', qtyGross: 6 },
          { productId: 'minyak', productNama: 'Minyak', satuan: 'ML', qtyGross: 3000 },
        ],
      },
    ]);

    await db.collection('inventory_releases').insertMany([
      { tenantId: TID, noRelease: 'RL-1', productionPlanId: PLAN.id, status: 'POSTED', items: [{ stokId: 'gula-lama', qty: 5, qtyBase: 5 }] },
      { tenantId: TID, noRelease: 'RL-2', productionPlanId: PLAN.id, status: 'POSTED', items: [{ stokId: 'gula-b', qty: 1, qtyBase: 1 }] },
      { tenantId: TID, productionPlanId: PLAN.id, status: 'DRAFT', items: [{ stokId: 'gula', qty: 50, qtyBase: 50 }] },
      { tenantId: TID, productionPlanId: 'plan-lain', status: 'POSTED', items: [{ stokId: 'gula', qty: 50, qtyBase: 50 }] },
      { tenantId: TID, status: 'POSTED', items: [{ stokId: 'gula', qty: 50, qtyBase: 50 }] },
      {
        tenantId: TID,
        noRelease: 'RL-OP',
        status: 'POSTED',
        tanggal: new Date('2026-09-20T09:00:00+07:00'),
        items: [{ stokId: 'telur', qty: 1, qtyBase: 1 }, { stokId: 'daun', qty: 1, qtyBase: 1 }],
      },
      {
        tenantId: TID,
        noRelease: 'RL-OP-KEMARIN',
        status: 'POSTED',
        tanggal: new Date('2026-09-19T09:00:00+07:00'),
        items: [{ stokId: 'telur', qty: 7, qtyBase: 7 }],
      },
    ]);

    await db.collection('material_issues').insertMany([
      { tenantId: TID, productionPlanId: PLAN.id, status: 'COMPLETED', stockPostedAt: new Date(), lines: [{ productId: 'minyak', qtyIssued: 1 }] },
      { tenantId: TID, productionPlanId: PLAN.id, status: 'COMPLETED', lines: [{ productId: 'minyak', qtyIssued: 0.5 }] },
      { tenantId: TID, productionPlanId: PLAN.id, status: 'COMPLETED', stockMode: 'REFERENCE', lines: [{ productId: 'minyak', qtyIssued: 9 }] },
      { tenantId: TID, productionPlanId: PLAN.id, status: 'DRAFT', lines: [{ productId: 'minyak', qtyIssued: 9 }] },
    ]);
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('menjumlah semua PO rencana dalam satuan dasar dan mengurangi RL tertaut', async () => {
    const ref = await loadPlanReference(db, scope, PLAN, { withStock: true });
    const byId = new Map(ref.lines.map((l) => [l.productId, l]));

    expect(ref.mrpSource).toBe('MRP_DOC');
    expect(ref.materialRequirementId).toBe('mrp-1');

    const gula = byId.get('gula')!;
    expect(byId.has('gula-lama')).toBe(false);
    expect(byId.has('gula-b')).toBe(false);
    expect(gula).toMatchObject({
      productIds: ['gula', 'gula-b'],
      aliasProductIds: ['gula-lama'],
      sumber: 'PO',
      satuan: 'KG',
      poQtyOrdered: 30,
      poQtyReceived: 24,
      acuanQty: 24,
      qtyMrp: 20,
      rlPosted: 6,
      pblPosted: 0,
      sisa: 18,
      qtyOnHand: 10,
    });
    expect(gula.poRefs.map((r) => r.noPO).sort()).toEqual(['CPO-1', 'CPO-2']);
    expect(gula.rlRefs).toEqual([
      { noRelease: 'RL-1', qty: 5 },
      { noRelease: 'RL-2', qty: 1 },
    ]);

    const minyak = byId.get('minyak')!;
    expect(minyak).toMatchObject({ sumber: 'MRP', acuanQty: 3, qtyMrp: 3, pblPosted: 1.5, rlPosted: 0, sisa: 1.5, qtyOnHand: 2 });
    expect(minyak.poRefs).toHaveLength(0);

    const daun = byId.get('daun')!;
    expect(daun.sumber).toBe('PO');
    expect(daun.rlPosted).toBe(0);
    expect(daun.warnings?.[0]).toMatch(/IKAT tidak terkonversi/);
  });

  it('RL tanpa tautan tidak ditebak ke rencana (masuk worklist)', async () => {
    const ref = await loadPlanReference(db, scope, PLAN);
    const telur = ref.lines.find((l) => l.productId === 'telur')!;
    expect(telur).toMatchObject({ sumber: 'PO', poQtyOrdered: 5, poQtyReceived: 4, acuanQty: 4, rlPosted: 0, sisa: 4 });
    expect(telur.rlRefs).toEqual([]);
  });

  it('membaca dalam snapshot transaksi bila diberi session', async () => {
    const outside = await loadPlanReference(db, scope, PLAN);
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await db.collection('inventory_releases').insertOne(
          { tenantId: TID, noRelease: 'RL-TX', productionPlanId: PLAN.id, status: 'POSTED', items: [{ stokId: 'gula', qtyBase: 2 }] },
          { session },
        );
        const inside = await loadPlanReference(db, scope, PLAN, { session });
        const gulaIn = inside.lines.find((l) => l.productId === 'gula')!;
        const gulaOut = outside.lines.find((l) => l.productId === 'gula')!;
        expect(gulaIn.rlPosted).toBe(gulaOut.rlPosted + 2);
        await session.abortTransaction();
      });
    } catch {
      // abortTransaction di dalam callback membuat withTransaction selesai tanpa commit.
    } finally {
      await session.endSession();
    }
    const after = await loadPlanReference(db, scope, PLAN);
    expect(after.lines.find((l) => l.productId === 'gula')!.rlPosted)
      .toBe(outside.lines.find((l) => l.productId === 'gula')!.rlPosted);
  });

  it('kekurangan PO dari dipesan − diterima, tidak ditimpa konsumsi', async () => {
    const ref = await loadPlanReference(db, scope, PLAN, { withStock: true });
    const ready = planReferenceReadiness(ref);
    const byId = new Map(ready.lines.map((l) => [l.productId, l]));

    expect(byId.get('gula')).toMatchObject({ sourceOfTruth: 'PO', qtyNet: 6, shortage: true, acuanQty: 24, rlPosted: 6, sisa: 18 });
    expect(byId.get('telur')).toMatchObject({ qtyNet: 1, shortage: true });
    expect(byId.get('minyak')).toMatchObject({ qtyNet: 0, shortage: false });
    expect(ready.summary.shortageCount).toBe(2);
  });

  it('kode sama dengan satuan dasar berbeda tidak digabung', async () => {
    const ref = await loadPlanReference(db, scope, { id: 'plan-garam', tenantId: TID }, {
      fallbackMrpLines: [
        { productId: 'garam', satuan: 'KG', qtyGross: 1 },
        { productId: 'garam-pak', satuan: 'PAK', qtyGross: 1.2 },
      ],
    });
    expect(ref.lines.map((l) => [l.productId, l.satuan, l.qtyMrp, l.acuanQty]).sort()).toEqual([
      ['garam', 'KG', 1, 1],
      ['garam-pak', 'PAK', 1.2, 2],
    ]);
  });

  it('tanpa dokumen MRP memakai baris explode sebagai cadangan', async () => {
    const plan = { id: 'plan-baru', tenantId: TID };
    const ref = await loadPlanReference(db, scope, plan, {
      fallbackMrpLines: [{ productId: 'gula-lama', productNama: 'Gula', satuan: 'GR', qtyGross: 2500 }],
    });
    expect(ref.mrpSource).toBe('LIVE');
    expect(ref.lines).toHaveLength(1);
    expect(ref.lines[0]).toMatchObject({ productId: 'gula', sumber: 'MRP', acuanQty: 2.5, sisa: 2.5 });
    expect(ref.lines[0].qtyOnHand).toBeUndefined();
  });

  it('rencana tanpa PO, MRP, dan RL menghasilkan acuan kosong', async () => {
    const ref = await loadPlanReference(db, scope, { id: 'plan-kosong', tenantId: TID });
    expect(ref.mrpSource).toBe('NONE');
    expect(ref.lines).toEqual([]);
    expect(ref.summary).toMatchObject({ lineCount: 0, acuanTotal: 0, sisaTotal: 0 });
  });
});
