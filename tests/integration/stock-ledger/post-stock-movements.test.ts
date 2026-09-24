/**
 * Buku stok (lib/stock-ledger) terhadap MongoDB replica set sungguhan (mongodb-memory-server).
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang (mis. image build produksi).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import {
  applyMasterProductStockChange,
  postStockMovements,
  relocateProductWarehouseWithAudit,
  roundStockQty,
  setProductWarehouseStock,
} from '@/lib/stock-ledger';
import { adjustStokBin } from '@/lib/stock-ledger/bin';
import { postStockMutation } from '@/lib/api/stock-mutation';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-tenant';

describe.skipIf(!MongoMemoryReplSet)('postStockMovements (Mongo replica set)', { timeout: 60_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('stock_ledger_it');
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true });
    await db.collection('stok_kartu').createIndex(
      { tenantId: 1, sourceType: 1, sourceId: 1, lineRef: 1 },
      {
        name: 'uniq_stok_kartu_source_line',
        unique: true,
        partialFilterExpression: { sourceId: { $type: 'string', $gt: '' }, lineRef: { $type: 'string', $gt: '' } },
      },
    );
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  beforeEach(async () => {
    for (const c of ['products', 'stok_lokasi', 'stok_kartu', 'stok_bin', 'tenant_settings', 'ingredient_lots', 'audit_log', 'penyesuaian_stok']) {
      await db.collection(c).deleteMany({});
    }
    await db.collection('products').insertMany([
      { id: 'gula', tenantId: TID, kode: 'GM', nama: 'Gula Merah', gudangKode: 'GKERING', hargaBeli: 18, stok: 0 },
      { id: 'ikan', tenantId: TID, kode: 'IK', nama: 'Ikan', gudangKode: 'GBASAH', hargaBeli: 50, stok: 0 },
    ]);
  });

  async function seed(stokId: string, lokasiKode: string, qty: number, kartuMasuk = qty) {
    await db.collection('stok_lokasi').insertOne({ id: `${stokId}-${lokasiKode}`, tenantId: TID, stokId, lokasiKode, qty });
    if (kartuMasuk) {
      await db.collection('stok_kartu').insertOne({ id: `seed-${stokId}`, tenantId: TID, stokId, lokasiKode, masuk: kartuMasuk, keluar: 0 });
    }
  }

  async function lokasiQty(stokId: string, lokasiKode = 'GKERING') {
    const row = await db.collection('stok_lokasi').findOne({ tenantId: TID, stokId, lokasiKode });
    return row?.qty as number | undefined;
  }

  function out(stokId: string, qty: number, extra: Record<string, unknown> = {}) {
    return {
      tenantId: TID,
      sourceType: 'RELEASE',
      sourceId: 'rl-1',
      noTransaksi: 'RL-1',
      keterangan: 'test',
      lines: [{ lineRef: '1', productId: stokId, warehouseKode: 'GKERING', deltaQtyBase: -qty }],
      ...extra,
    };
  }

  it('keluar 0.1 dari stok 0.0999… berhasil dan hasilnya tepat 0 (kasus Gula Merah)', async () => {
    const dust = 1 - 0.9 - 0.0000000000000001;
    await seed('gula', 'GKERING', dust, dust);
    const res = await postStockMovements(db, undefined, out('gula', 0.1));
    expect(res.ok).toBe(true);
    expect(await lokasiQty('gula')).toBe(0);
    const prod = await db.collection('products').findOne({ id: 'gula' });
    expect(prod?.stok).toBe(0);
  });

  it('1 − 0.9 disimpan tepat 0.1 (tanpa float dust)', async () => {
    await seed('gula', 'GKERING', 1);
    const res = await postStockMovements(db, undefined, out('gula', 0.9));
    expect(res.ok).toBe(true);
    expect(await lokasiQty('gula')).toBe(0.1);
  });

  it('stok kurang ditolak tanpa menulis apa pun', async () => {
    await seed('gula', 'GKERING', 2);
    const res = await postStockMovements(db, undefined, out('gula', 3));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('tidak cukup');
    expect(await lokasiQty('gula')).toBe(2);
    expect(await db.collection('stok_kartu').countDocuments({ noTransaksi: 'RL-1' })).toBe(0);
  });

  it('keluar dibatasi saldo kartu untuk RELEASE, tetapi PENYESUAIAN boleh', async () => {
    await seed('gula', 'GKERING', 10, 3);
    const rl = await postStockMovements(db, undefined, out('gula', 5));
    expect(rl.ok).toBe(false);
    if (!rl.ok) expect(rl.error).toContain('saldo kartu');
    const ps = await postStockMovements(db, undefined, out('gula', 5, { sourceType: 'PENYESUAIAN', noTransaksi: 'PS-1' }));
    expect(ps.ok).toBe(true);
    expect(await lokasiQty('gula')).toBe(5);
  });

  it('baris berurutan pada SKU yang sama saling memperhitungkan (masuk lalu keluar)', async () => {
    await seed('gula', 'GKERING', 1);
    const res = await postStockMovements(db, undefined, {
      tenantId: TID,
      sourceType: 'FP_ADJUST',
      sourceId: 'adj-1',
      noTransaksi: 'ADJ-1',
      keterangan: 'multi',
      lines: [
        { lineRef: 'a', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: 2 },
        { lineRef: 'b', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: -3 },
      ],
    });
    expect(res.ok).toBe(true);
    expect(await lokasiQty('gula')).toBe(0);
  });

  it('menolak lineRef ganda, gudang salah, produk tidak dikenal', async () => {
    await seed('gula', 'GKERING', 5);
    const dup = await postStockMovements(db, undefined, {
      ...out('gula', 1),
      lines: [
        { lineRef: 'x', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: -1 },
        { lineRef: 'x', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: -1 },
      ],
    });
    expect(dup.ok).toBe(false);
    const wrongWh = await postStockMovements(db, undefined, {
      ...out('gula', 1),
      lines: [{ lineRef: '1', productId: 'gula', warehouseKode: 'GBASAH', deltaQtyBase: -1 }],
    });
    expect(wrongWh.ok).toBe(false);
    const unknown = await postStockMovements(db, undefined, out('tidak-ada', 1));
    expect(unknown.ok).toBe(false);
    expect(await lokasiQty('gula')).toBe(5);
  });

  it('menolak posting di periode terkunci', async () => {
    await seed('gula', 'GKERING', 5);
    await db.collection('tenant_settings').insertOne({ tenantId: TID, periodLockedUntil: new Date(Date.now() + 86_400_000).toISOString() });
    const res = await postStockMovements(db, undefined, out('gula', 1));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('terkunci');
    expect(await lokasiQty('gula')).toBe(5);
  });

  it('kartu membawa lineRef, sourceId, postingDate, pelaku, dan harga rata-rata untuk keluar', async () => {
    await seed('gula', 'GKERING', 5);
    const postingDate = new Date('2026-09-24T03:00:00Z');
    const res = await postStockMovements(db, undefined, out('gula', 2, {
      postingDate,
      actor: { userId: 'u1', userName: 'Approver', role: 'ADMIN' },
    }));
    expect(res.ok).toBe(true);
    const kartu = await db.collection('stok_kartu').findOne({ noTransaksi: 'RL-1' });
    expect(kartu).toMatchObject({
      lineRef: '1',
      sourceId: 'rl-1',
      sourceType: 'RELEASE',
      keluar: 2,
      masuk: 0,
      hargaSatuan: 18,
      costSource: 'PRODUCT_AVG',
      createdBy: { userId: 'u1', userName: 'Approver', role: 'ADMIN' },
    });
    expect((kartu?.postingDate as Date).toISOString()).toBe(postingDate.toISOString());
    expect((kartu?.tanggal as Date).toISOString()).toBe(postingDate.toISOString());
  });

  it('rollback transaksi membatalkan mutasi baris sebelumnya', async () => {
    await seed('gula', 'GKERING', 5);
    const session = client.startSession();
    await expect(session.withTransaction(async () => {
      const first = await postStockMovements(db, session, out('gula', 2));
      expect(first.ok).toBe(true);
      const second = await postStockMovements(db, session, out('gula', 10, { sourceId: 'rl-2', noTransaksi: 'RL-2' }));
      if (!second.ok) throw new Error(second.error);
    })).rejects.toThrow('tidak cukup');
    await session.endSession();
    expect(await lokasiQty('gula')).toBe(5);
    expect(await db.collection('stok_kartu').countDocuments({ noTransaksi: { $in: ['RL-1', 'RL-2'] } })).toBe(0);
  });

  it('posting ulang dokumen+baris yang sama ditolak tanpa mengubah saldo (idempoten)', async () => {
    await seed('gula', 'GKERING', 5);
    expect((await postStockMovements(db, undefined, out('gula', 2))).ok).toBe(true);
    const again = await postStockMovements(db, undefined, out('gula', 2));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain('posting ganda');
    expect(await lokasiQty('gula')).toBe(3);
    expect(await db.collection('stok_kartu').countDocuments({ sourceId: 'rl-1' })).toBe(1);
    const otherLine = await postStockMovements(db, undefined, {
      ...out('gula', 1),
      lines: [{ lineRef: '2', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: -1 }],
    });
    expect(otherLine.ok).toBe(true);
    expect(await lokasiQty('gula')).toBe(2);
  });

  it('posting ganda paralel: tepat satu berhasil (index unik sebagai guard)', async () => {
    await seed('gula', 'GKERING', 10);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => postStockMovements(db, undefined, out('gula', 1, { sourceId: 'rl-race', noTransaksi: 'RL-RACE' }))),
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(await lokasiQty('gula')).toBe(9);
    expect(await db.collection('stok_kartu').countDocuments({ sourceId: 'rl-race' })).toBe(1);
  });

  it('sourceId kosong ditolak', async () => {
    await seed('gula', 'GKERING', 5);
    const res = await postStockMovements(db, undefined, out('gula', 1, { sourceId: '' }));
    expect(res.ok).toBe(false);
    expect(await lokasiQty('gula')).toBe(5);
  });

  it('keluar paralel tidak pernah membuat stok negatif (guard atomik)', async () => {
    await seed('gula', 'GKERING', 5);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => postStockMovements(db, undefined, out('gula', 1, { sourceId: `rl-p${i}`, noTransaksi: `RL-P${i}` }))),
    );
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(5);
    expect(await lokasiQty('gula')).toBe(0);
    const keluar = await db.collection('stok_kartu')
      .aggregate([{ $match: { noTransaksi: /^RL-P/ } }, { $group: { _id: null, k: { $sum: '$keluar' } } }])
      .toArray();
    expect(keluar[0]?.k).toBe(5);
  });

  it('masuk paralel pertama tidak menggandakan baris saldo', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => postStockMovements(db, undefined, {
        tenantId: TID,
        sourceType: 'GRN',
        sourceId: `grn-race-${i}`,
        noTransaksi: `GRN-R${i}`,
        keterangan: 'masuk paralel',
        lines: [{ lineRef: '1', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: 1, binPolicy: 'NONE' }],
      })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await lokasiQty('gula')).toBe(8);
    expect(await db.collection('stok_lokasi').countDocuments({ tenantId: TID, stokId: 'gula', lokasiKode: 'GKERING' })).toBe(1);
  });

  it('invariant: stok_lokasi = Σ kartu dan products.stok = Σ stok_lokasi setelah urutan acak', async () => {
    let seedVal = 42;
    const rand = () => {
      seedVal = (seedVal * 1103515245 + 12345) % 2 ** 31;
      return seedVal / 2 ** 31;
    };
    for (let i = 0; i < 60; i += 1) {
      const qty = roundStockQty(rand() * 3 + 0.0001);
      const inbound = rand() < 0.55;
      await postStockMovements(db, undefined, {
        tenantId: TID,
        sourceType: inbound ? 'GRN' : 'RELEASE',
        sourceId: `r-${i}`,
        noTransaksi: `R-${i}`,
        keterangan: 'acak',
        lines: [{ lineRef: '1', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: inbound ? qty : -qty }],
      });
    }
    const lok = await lokasiQty('gula') ?? 0;
    const kartu = await db.collection('stok_kartu').find({ stokId: 'gula' }).toArray();
    const saldo = roundStockQty(kartu.reduce((s, k) => s + (k.masuk || 0) - (k.keluar || 0), 0));
    const prod = await db.collection('products').findOne({ id: 'gula' });
    expect(lok).toBeGreaterThanOrEqual(0);
    expect(lok).toBe(saldo);
    expect(prod?.stok).toBe(lok);
    expect(Number.isInteger(Math.round(lok * 1e4)) && Math.abs(lok * 1e4 - Math.round(lok * 1e4)) < 1e-6).toBe(true);
  });

  it('GRN: baris ganda SKU sama dijumlah atomik, kartu per baris, master & lot konsisten', async () => {
    await seed('gula', 'GKERING', 2);
    const grn = {
      id: 'grn-1',
      noGRN: 'GRN-1',
      noDO: 'DO-1',
      items: [
        { localStokId: 'gula', vendorKode: 'GM', qtyOrdered: 3, harga: 20, satuan: 'KG' },
        { localStokId: 'gula', vendorKode: 'GM', qtyOrdered: 1.5, harga: 20, satuan: 'KG' },
      ],
    };
    const res = await applyGrnStockPosting(db, TID, grn as never, [], undefined);
    expect(res.error).toBeUndefined();
    expect(await lokasiQty('gula')).toBe(6.5);
    const kartu = await db.collection('stok_kartu').find({ noTransaksi: 'GRN-1' }).sort({ lineRef: 1 }).toArray();
    expect(kartu.map((k) => [k.lineRef, k.masuk, k.sourceId])).toEqual([['0', 3, 'grn-1'], ['1', 1.5, 'grn-1']]);
    const prod = await db.collection('products').findOne({ id: 'gula' });
    expect(prod?.stok).toBe(6.5);
    expect(await db.collection('ingredient_lots').countDocuments({ grnId: 'grn-1' })).toBe(2);
  });

  it('GRN paralel pada SKU sama tidak saling menimpa (tanpa lost update)', async () => {
    await seed('gula', 'GKERING', 1);
    const mk = (i: number) => ({
      id: `grn-p${i}`,
      noGRN: `GRN-P${i}`,
      noDO: `DO-P${i}`,
      items: [{ localStokId: 'gula', vendorKode: 'GM', qtyOrdered: 1, harga: 20, satuan: 'KG' }],
    });
    const results = await Promise.all([0, 1, 2, 3, 4].map((i) => applyGrnStockPosting(db, TID, mk(i) as never, [], undefined)));
    expect(results.every((r) => !r.error)).toBe(true);
    expect(await lokasiQty('gula')).toBe(6);
    const prod = await db.collection('products').findOne({ id: 'gula' });
    expect(prod?.stok).toBe(6);
  });

  it('postStockMutation (adapter) meneruskan ke buku stok', async () => {
    await seed('ikan', 'GBASAH', 4);
    const res = await postStockMutation(db, {
      tenantId: TID,
      productId: 'ikan',
      warehouseKode: 'GBASAH',
      deltaQtyBase: -1.5,
      sourceType: 'FP_ISSUE',
      sourceId: 'pbl-1',
      noTransaksi: 'PBL-1',
      keterangan: 'issue',
    });
    expect(res).toMatchObject({ ok: true, qtyAfter: 2.5, lokasiKode: 'GBASAH' });
    const kartu = await db.collection('stok_kartu').findOne({ noTransaksi: 'PBL-1' });
    expect(kartu).toMatchObject({ lineRef: 'ikan', keluar: 1.5, hargaSatuan: 50, costSource: 'PRODUCT_AVG' });
  });
  async function seedLot(id: string, stokId: string, warehouseKode: string, qty: number, expiryDate: string) {
    await db.collection('ingredient_lots').insertOne({
      id, tenantId: TID, lotNo: id, productId: stokId, warehouseKode, qty, qtyRemaining: qty,
      status: 'ACTIVE', receivedAt: '2026-09-01', expiryDate, createdAt: new Date(), updatedAt: new Date(),
    });
  }

  it('lotPolicy FEFO_CONSUME: lot dikonsumsi FEFO di sesi yang sama, alokasi tercatat di kartu', async () => {
    await seed('gula', 'GKERING', 5);
    await seedLot('L-late', 'gula', 'GKERING', 3, '2026-12-31');
    await seedLot('L-early', 'gula', 'GKERING', 2, '2026-10-01');
    const res = await postStockMovements(db, undefined, {
      ...out('gula', 2.5),
      lines: [{ lineRef: '1', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: -2.5, lotPolicy: { mode: 'FEFO_CONSUME' } }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lines[0].lot).toMatchObject({ allocated: 2.5, shortfall: 0, skippedNoLots: false });
    const early = await db.collection('ingredient_lots').findOne({ id: 'L-early' });
    const late = await db.collection('ingredient_lots').findOne({ id: 'L-late' });
    expect(early).toMatchObject({ qtyRemaining: 0, status: 'CONSUMED' });
    expect(late?.qtyRemaining).toBe(2.5);
    const kartu = await db.collection('stok_kartu').findOne({ noTransaksi: 'RL-1' });
    expect((kartu?.ingredientLotAllocations as unknown[]).length).toBe(2);
  });

  it('lotPolicy CREATE: qty/produk/gudang lot dipaksa sama dengan baris posting', async () => {
    const res = await postStockMovements(db, undefined, {
      tenantId: TID,
      sourceType: 'GRN',
      sourceId: 'grn-x',
      noTransaksi: 'GRN-X',
      keterangan: 'lot',
      lines: [{
        lineRef: '0', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: 1.23456,
        lotPolicy: { mode: 'CREATE', lot: { lotNo: 'LOT-X', receivedAt: '2026-09-24', expiryDate: '2026-12-01', productId: 'ikan', qty: 99 } as never },
      }],
    });
    expect(res.ok).toBe(true);
    const lot = await db.collection('ingredient_lots').findOne({ lotNo: 'LOT-X' });
    expect(lot).toMatchObject({ productId: 'gula', warehouseKode: 'GKERING', qty: 1.2346, qtyRemaining: 1.2346, tenantId: TID });
    expect(await lokasiQty('gula')).toBe(1.2346);
  });

  it('lotPolicy RELOCATE + RESTORE + VARIANCE', async () => {
    await seed('gula', 'GKERING', 4);
    await seedLot('L1', 'gula', 'GKERING', 4, '2026-11-01');
    const moved = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'TRANSFER', sourceId: 'tr-1', noTransaksi: 'TR-1', keterangan: 'tr',
      lines: [
        { lineRef: '1:OUT', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: -1, lotPolicy: { mode: 'RELOCATE', toWarehouseKode: 'DAPUR1' } },
      ],
    });
    expect(moved.ok).toBe(true);
    const dest = await db.collection('ingredient_lots').findOne({ productId: 'gula', warehouseKode: 'DAPUR1' });
    expect(dest).toMatchObject({ qty: 1, qtyRemaining: 1, relocatedFromLotId: 'L1' });

    const restored = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'VENDOR_RETURN_REJECTED', sourceId: 'rtv-1', noTransaksi: 'RTV-1', keterangan: 'rj',
      lines: [{
        lineRef: 'l1', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: 0.5,
        lotPolicy: { mode: 'RESTORE', restores: [{ batchId: 'L1', expiryDate: '2026-11-01', qty: 0.5 }] },
      }],
    });
    expect(restored.ok).toBe(true);
    expect((await db.collection('ingredient_lots').findOne({ id: 'L1' }))?.qtyRemaining).toBe(3.5);

    const variance = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'PENYESUAIAN', sourceId: 'ps-1', noTransaksi: 'PS-1', keterangan: 'cc',
      lines: [{ lineRef: 'gula', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: -0.3, lotPolicy: { mode: 'VARIANCE' } }],
    });
    expect(variance.ok).toBe(true);
    expect((await db.collection('ingredient_lots').findOne({ id: 'L1' }))?.qtyRemaining).toBe(3.2);
  });

  it('lotPolicy salah arah ditolak sebelum menulis', async () => {
    await seed('gula', 'GKERING', 5);
    const res = await postStockMovements(db, undefined, {
      ...out('gula', 1),
      lines: [{ lineRef: '1', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: 1, lotPolicy: { mode: 'FEFO_CONSUME' } }],
    });
    expect(res.ok).toBe(false);
    expect(await lokasiQty('gula')).toBe(5);
  });

  it('audit log STOCK_POSTING ditulis di sesi yang sama dan ikut rollback', async () => {
    await seed('gula', 'GKERING', 5);
    const okRes = await postStockMovements(db, undefined, out('gula', 1, { actor: { userId: 'u9', userName: 'Gudang' } }));
    expect(okRes.ok).toBe(true);
    const audit = await db.collection('audit_log').findOne({ action: 'STOCK_POSTING', entityId: 'rl-1' });
    expect(audit).toMatchObject({ entityType: 'RELEASE', userId: 'u9', tenantId: TID });
    expect((audit?.metadata as { lines: unknown[] }).lines).toHaveLength(1);

    const session = client.startSession();
    await expect(session.withTransaction(async () => {
      const first = await postStockMovements(db, session, out('gula', 1, { sourceId: 'rl-rb', noTransaksi: 'RL-RB' }));
      expect(first.ok).toBe(true);
      throw new Error('batal');
    })).rejects.toThrow('batal');
    await session.endSession();
    expect(await db.collection('audit_log').countDocuments({ entityId: 'rl-rb' })).toBe(0);
  });

  it('bin: mutasi dibulatkan 4 dp dan keluar dust diterima dengan toleransi', async () => {
    await db.collection('stok_bin').insertOne({ id: 'b1', tenantId: TID, stokId: 'gula', warehouseKode: 'GKERING', binKode: 'A-01', qty: 1 - 0.9 - 1e-16 });
    const out1 = await adjustStokBin(db, TID, 'gula', 'GKERING', 'A-01', -0.1);
    expect(out1).toEqual({ qty: 0 });
    const in1 = await adjustStokBin(db, TID, 'gula', 'GKERING', 'A-01', 0.1 + 0.2);
    expect(in1).toEqual({ qty: 0.3 });
  });

  it('setProductWarehouseStock menolak stok non-nol (wajib lewat buku stok)', async () => {
    const res = await setProductWarehouseStock(db, TID, 'gula', 'GKERING', 5);
    expect('error' in res).toBe(true);
    expect(await lokasiQty('gula')).toBeUndefined();
  });

  it('edit stok master = penyesuaian lewat buku stok (kartu + dokumen PS + audit)', async () => {
    await seed('gula', 'GKERING', 5);
    const product = await db.collection('products').findOne({ id: 'gula' });
    const res = await applyMasterProductStockChange(db, {
      tenantId: TID, product: product as never, gudangKode: 'GKERING', qtyAfter: 3.3,
    });
    expect(res).toMatchObject({ ok: true, qty: 3.3, qtyBefore: 5, selisih: -1.7 });
    expect(await lokasiQty('gula')).toBe(3.3);
    const kartu = await db.collection('stok_kartu').findOne({ sourceType: 'PENYESUAIAN', stokId: 'gula' });
    expect(kartu).toMatchObject({ keluar: 1.7, lineRef: 'gula' });
    expect(await db.collection('penyesuaian_stok').countDocuments({ source: 'MASTER_PRODUK' })).toBe(1);
    expect(await db.collection('audit_log').countDocuments({ action: 'STOCK_POSTING', entityType: 'PENYESUAIAN' })).toBe(1);
  });

  it('pindah gudang produk lewat buku stok: kartu keluar/masuk, master ikut gudang baru', async () => {
    await seed('gula', 'GKERING', 2.5);
    const product = await db.collection('products').findOne({ id: 'gula' });
    const session = client.startSession();
    let res: unknown;
    await session.withTransaction(async () => {
      res = await relocateProductWarehouseWithAudit(db, { tenantId: TID, product: product as never, nextGudang: 'GBASAH', session });
    });
    await session.endSession();
    expect(res).toMatchObject({ moved: 2.5, from: 'GKERING', to: 'GBASAH' });
    expect(await lokasiQty('gula', 'GKERING')).toBeUndefined();
    expect(await lokasiQty('gula', 'GBASAH')).toBe(2.5);
    const prod = await db.collection('products').findOne({ id: 'gula' });
    expect(prod).toMatchObject({ gudangKode: 'GBASAH', stok: 2.5 });
    const kartu = await db.collection('stok_kartu').find({ sourceType: 'RELOKASI_GUDANG' }).sort({ lineRef: 1 }).toArray();
    expect(kartu.map((k) => [k.lineRef, k.lokasiKode, k.masuk, k.keluar])).toEqual([
      ['IN', 'GBASAH', 2.5, 0],
      ['OUT', 'GKERING', 0, 2.5],
    ]);
  });
});
