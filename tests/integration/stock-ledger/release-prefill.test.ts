/**
 * Fase 1.2 — prefill RL dari acuan rencana pada Mongo replica set.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import { loadReleasePrefill } from '@/lib/food-production/release-prefill';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-12';
const scope = { tenantId: TID, role: 'ADMIN' } as AuthContext;
const PLAN = { id: 'plan-1', tenantId: TID };

function uom(productId: string, satuan: string, factorToBase: number, isBase = false) {
  return { id: `${productId}-${satuan}`, tenantId: TID, productId, satuan, factorToBase, isBase, aktif: true, sortOrder: isBase ? 0 : 1 };
}

describe.skipIf(!MongoMemoryReplSet)('loadReleasePrefill (Mongo replica set)', { timeout: 60_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('release_prefill_it');

    const product = (id: string, kode: string, gudangKode: string) => ({
      id, tenantId: TID, kode, nama: id, satuan: 'KG', aktif: true, gudangKode,
    });
    await db.collection('products').insertMany([
      product('gula', 'GL01', 'GKERING'),
      product('telur', 'TL01', 'GBASAH'),
      product('minyak', 'MY01', 'GKERING'),
      product('beras', 'BR01', 'GKERING'),
      product('kecap', 'KC01', 'GKERING'),
    ]);
    await db.collection('product_uom').insertMany([
      uom('gula', 'KG', 1, true),
      uom('gula', 'DUS', 12),
      ...['telur', 'minyak', 'beras', 'kecap'].map((id) => uom(id, 'KG', 1, true)),
    ]);
    await db.collection('stok_lokasi').insertMany([
      { tenantId: TID, stokId: 'gula', lokasiKode: 'GKERING', qty: 30 },
      { tenantId: TID, stokId: 'telur', lokasiKode: 'GBASAH', qty: 9 },
      { tenantId: TID, stokId: 'minyak', lokasiKode: 'GKERING', qty: 9 },
    ]);
    await db.collection('stok_kartu').insertOne({ tenantId: TID, stokId: 'gula', masuk: 28, keluar: 0 });
    await db.collection('production_batches').insertOne({
      id: 'b-hold', tenantId: TID, finishedGoodProductId: 'gula', warehouseKode: 'GKERING',
      status: 'ACTIVE', foodSafetyStatus: 'HOLD', qty: 5, qtyRemaining: 5, batchNo: 'B-1',
    });

    await db.collection('customer_purchase_orders').insertOne({
      id: 'po-1', tenantId: TID, noPO: 'CPO-1', productionPlanId: PLAN.id, status: 'RECEIVED', createdAt: new Date(1),
      items: [
        { localStokId: 'gula', kode: 'GL01', satuan: 'DUS', uomId: 'gula-DUS', qty: 2, qtyReceived: 2 },
        { localStokId: 'telur', kode: 'TL01', satuan: 'KG', qty: 5, qtyReceived: 5 },
        { localStokId: 'minyak', kode: 'MY01', satuan: 'KG', qty: 10, qtyReceived: 10 },
        { localStokId: 'beras', kode: 'BR01', satuan: 'KG', qty: 3, qtyReceived: 3 },
        { localStokId: 'kecap', kode: 'KC01', satuan: 'KG', qty: 1, qtyReceived: 1 },
      ],
    });
    await db.collection('inventory_releases').insertMany([
      { id: 'rl-posted', tenantId: TID, noRelease: 'RL-1', productionPlanId: PLAN.id, status: 'POSTED', items: [{ stokId: 'beras', qty: 3, qtyBase: 3 }] },
      { id: 'rl-pending', tenantId: TID, noRelease: 'RL-2', productionPlanId: PLAN.id, status: 'PENDING_APPROVAL', items: [{ stokId: 'minyak', qty: 10, qtyBase: 10 }] },
      { id: 'rl-edit', tenantId: TID, noRelease: 'RL-3', productionPlanId: PLAN.id, status: 'DRAFT', items: [{ stokId: 'gula', qty: 4, qtyBase: 4 }] },
      { id: 'rl-tolak', tenantId: TID, noRelease: 'RL-4', productionPlanId: PLAN.id, status: 'REJECTED', items: [{ stokId: 'gula', qty: 50, qtyBase: 50 }] },
    ]);
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('dibatasi saldo kartu dan batch HOLD; RL yang sedang diedit tidak dihitung menunggu', async () => {
    const prefill = await loadReleasePrefill(db, scope, PLAN, { lokasiKode: 'gkering', excludeReleaseId: 'rl-edit' });
    expect(prefill.lokasiKode).toBe('GKERING');
    expect(prefill.lines).toEqual([expect.objectContaining({
      stokId: 'gula',
      uomId: 'gula-KG',
      satuan: 'KG',
      qty: 23,
      qtyBase: 23,
      display: { qty: 1.9167, satuan: 'DUS' },
      acuanQty: 24,
      rlPending: 0,
      sisa: 24,
      stokAvail: 23,
      cappedByStock: true,
    })]);
    expect(prefill.skipped.map((s) => [s.productId, s.reason]).sort()).toEqual([
      ['beras', 'SELESAI'],
      ['kecap', 'STOK_KOSONG'],
      ['minyak', 'MENUNGGU_RL'],
      ['telur', 'GUDANG_LAIN'],
    ]);
    expect(prefill.summary).toEqual({ lineCount: 1, skippedCount: 4, cappedCount: 1 });
  });

  it('RL draft lain mengurangi qty usulan', async () => {
    const prefill = await loadReleasePrefill(db, scope, PLAN, { lokasiKode: 'GKERING' });
    expect(prefill.lines[0]).toMatchObject({ stokId: 'gula', qty: 20, rlPending: 4, cappedByStock: false });
  });

  it('gudang basah hanya mengisi produk gudang basah', async () => {
    const prefill = await loadReleasePrefill(db, scope, PLAN, { lokasiKode: 'GBASAH' });
    expect(prefill.lines.map((l) => [l.stokId, l.qty])).toEqual([['telur', 5]]);
  });
});
