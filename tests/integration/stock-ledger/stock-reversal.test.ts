/**
 * Fase 5c — dokumen pembalik stok (RVS) untuk RL, PBL berposting stok, dan penyesuaian.
 * Maker-checker ketat, kartu lawan pada harga kartu asli (rata-rata kembali), lot bahan dikembalikan,
 * jurnal dibalik, dokumen sumber berstatus REVERSED / CANCELLED.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { postStockMovements } from '@/lib/stock-ledger';
import { handleStockReversals } from '@/lib/api/handlers/stock-reversals';
import { handlePenyesuaian } from '@/lib/api/handlers/inventory-penyesuaian';
import { unjournaledConsumptionValue } from '@/lib/api/stock-cost-journal';
import type { AuthContext } from '@/types/auth';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-f5-rvs';

const auth = (userId: string, role: string, isMaster = false): AuthContext => ({
  userId, email: `${userId}@x`, name: userId, role, tenantId: TID, tenantName: TID, isMaster,
});
const GUDANG = auth('u-gudang', 'GUDANG');
const SPV = auth('u-spv', 'SUPERVISOR');
const ADMIN = auth('u-admin', 'ADMIN');
const MASTER = auth('u-master', 'MASTER', true);

describe.skipIf(!MongoMemoryReplSet)('Fase 5c pembalik stok (RVS)', { timeout: 180_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;
  let seq = 0;

  const request = (url: URL) => Object.assign(new Request(url), { cookies: { get: () => ({ value: TID }) } });

  const rvs = async (method: string, path: string[], body: unknown, who: AuthContext, query = '') => {
    const url = new URL(`http://x/api/${path.join('/')}${query}`);
    const res = await handleStockReversals({
      db, route: `/${path.join('/')}`, method, path, body, url, auth: who, request: request(url),
    });
    if (!res) throw new Error('handler tidak menangani route');
    return { status: res.status, data: await res.json() as Record<string, unknown> };
  };

  const penyesuaian = async (body: unknown, who: AuthContext) => {
    const path = ['stok', 'penyesuaian'];
    const url = new URL('http://x/api/stok/penyesuaian');
    const res = await handlePenyesuaian({ db, route: '/stok/penyesuaian', method: 'POST', path, body, url, auth: who, request: request(url) });
    return { status: res!.status, data: await res!.json() as Record<string, unknown> };
  };

  const lokasiQty = async (stokId: string) => Number((await db.collection('stok_lokasi').findOne({ tenantId: TID, stokId, lokasiKode: 'GKERING' }))?.qty || 0);
  const avgCost = async (stokId: string) => Number((await db.collection('products').findOne({ tenantId: TID, id: stokId }))?.avgCost);
  const lotRemaining = async (stokId: string) => {
    const lots = await db.collection('ingredient_lots').find({ tenantId: TID, productId: stokId }).toArray();
    return lots.reduce((s, l) => s + Number(l.qtyRemaining || 0), 0);
  };

  const grn = async (stokId: string, qty: number, unitCost: number) => {
    seq += 1;
    const res = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'GRN', sourceId: `grn-${seq}`, noTransaksi: `GRN-${seq}`,
      keterangan: 'seed', postingDate: new Date(),
      lines: [{
        lineRef: '1', productId: stokId, warehouseKode: 'GKERING', deltaQtyBase: qty, unitCost,
        lotPolicy: { mode: 'CREATE', lot: { lotNo: `L-${seq}`, receivedAt: '2026-09-01', expiryDate: '2027-12-31' } },
      }],
    });
    if (!res.ok) throw new Error(res.error);
  };

  const setFlags = (features: Record<string, boolean>) => db.collection('tenant_settings').updateOne(
    { tenantId: TID },
    { $set: Object.fromEntries(Object.entries(features).map(([k, v]) => [`features.${k}`, v])) },
    { upsert: true },
  );

  /** RL POSTED dengan kartu RELEASE yang mengonsumsi lot FEFO (seperti approve RL). */
  const postedRelease = async (id: string, stokId: string, qty: number, extra: Record<string, unknown> = {}) => {
    await db.collection('inventory_releases').insertOne({
      id, tenantId: TID, noRelease: `RL-${id}`, status: 'POSTED', lokasiKode: 'GKERING', keperluan: 'uji',
      items: [{ stokId, qty, qtyBase: qty }], createdBy: { userId: GUDANG.userId }, ...extra,
    });
    const res = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'RELEASE', sourceId: id, noTransaksi: `RL-${id}`, keterangan: 'RL uji', postingDate: new Date(),
      lines: [{ lineRef: `1:${stokId}`, productId: stokId, warehouseKode: 'GKERING', deltaQtyBase: -qty, lotPolicy: { mode: 'FEFO_CONSUME' } }],
    });
    if (!res.ok) throw new Error(res.error);
  };

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('stock_reversal_it');
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });
    await db.collection('stok_kartu').createIndex(
      { tenantId: 1, sourceType: 1, sourceId: 1, lineRef: 1 },
      { unique: true, name: 'uniq_stok_kartu_source_line', partialFilterExpression: { sourceId: { $type: 'string', $gt: '' }, lineRef: { $type: 'string', $gt: '' } } },
    );
    await db.collection('stock_reversals').createIndex(
      { tenantId: 1, sourceType: 1, sourceId: 1 },
      { unique: true, name: 'uniq_stock_reversal_active', partialFilterExpression: { active: true } },
    );
    for (const id of ['beras', 'minyak', 'telur']) {
      await db.collection('products').insertOne({
        id, tenantId: TID, kode: id.toUpperCase(), nama: id, satuan: 'KG', itemRole: 'INGREDIENT',
        aktif: true, syncSource: 'local', gudangKode: 'GKERING', hargaBeli: 1000, stok: 0,
      });
      await db.collection('product_uom').insertOne({
        id: `u-${id}`, tenantId: TID, productId: id, satuan: 'KG', isBase: true, factorToBase: 1, aktif: true, sortOrder: 0,
      });
    }
    await setFlags({ costingV2: true });
    await grn('beras', 10, 1000);
    await grn('minyak', 20, 500);
    await grn('telur', 5, 2000);
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('RL: maker-checker ketat, stok + lot + rata-rata kembali, jurnal dibalik, RL REVERSED', async () => {
    await postedRelease('rl-1', 'beras', 4);
    await db.collection('jurnal').insertOne({
      id: 'j-rl-1', tenantId: TID, sourceType: 'AUTO_RL_CONSUMPTION', sourceId: 'rl-1', tanggal: new Date(),
      details: [{ rekeningKode: '50100', debet: 4000, kredit: 0 }, { rekeningKode: '10310', debet: 0, kredit: 4000 }],
    });
    expect(await lokasiQty('beras')).toBe(6);
    expect(await lotRemaining('beras')).toBe(6);
    // Pembelian sesudah RL mengubah rata-rata; pembalik tetap masuk pada harga kartu RL (1000).
    await grn('beras', 10, 2000);
    expect(await avgCost('beras')).toBe(1625);

    const noReason = await rvs('POST', ['stock-reversals'], { sourceType: 'RELEASE', sourceId: 'rl-1', reason: '' }, GUDANG);
    expect(noReason.status).toBe(400);

    const req = await rvs('POST', ['stock-reversals'], { sourceType: 'RELEASE', sourceId: 'rl-1', reason: 'salah item' }, ADMIN);
    expect(req.status).toBe(201);
    const id = String(req.data.id);
    expect(String(req.data.noReversal)).toMatch(/^RVS/);
    expect((req.data.lines as Array<Record<string, unknown>>)[0]).toMatchObject({ productId: 'beras', deltaQtyBase: 4 });
    expect((req.data.lines as Array<Record<string, unknown>>)[0].unitCost).toBeUndefined();

    const dup = await rvs('POST', ['stock-reversals'], { sourceType: 'RELEASE', sourceId: 'rl-1', reason: 'dobel' }, GUDANG);
    expect(dup.status).toBe(409);

    // ADMIN pengaju tidak boleh menyetujui sendiri; GUDANG bukan penyetuju.
    expect((await rvs('POST', ['stock-reversals', id, 'approve'], {}, ADMIN)).status).toBe(403);
    expect((await rvs('POST', ['stock-reversals', id, 'approve'], {}, GUDANG)).status).toBe(403);

    const ok = await rvs('POST', ['stock-reversals', id, 'approve'], {}, SPV);
    expect(ok.status).toBe(200);
    expect(ok.data.status).toBe('POSTED');
    expect(await lokasiQty('beras')).toBe(20);
    expect(await lotRemaining('beras')).toBe(20);
    expect(await avgCost('beras')).toBe(1500);

    const kartu = await db.collection('stok_kartu').findOne({ tenantId: TID, sourceType: 'STOCK_REVERSAL', sourceId: id });
    expect(kartu).toMatchObject({ masuk: 4, hargaSatuan: 1000, reversalOfSourceType: 'RELEASE', reversalOfSourceId: 'rl-1' });
    expect(Array.isArray(kartu?.ingredientLotRestores) && kartu!.ingredientLotRestores.length).toBeGreaterThan(0);

    const rl = await db.collection('inventory_releases').findOne({ tenantId: TID, id: 'rl-1' });
    expect(rl).toMatchObject({ status: 'REVERSED', previousStatus: 'POSTED', reversedBy: { reversalId: id } });
    expect(rl?.reversalPendingId).toBeUndefined();

    const j = await db.collection('jurnal').findOne({ tenantId: TID, sourceType: 'AUTO_RVS_CONSUMPTION', sourceId: id });
    const details = (j?.details || []) as Array<Record<string, unknown>>;
    expect(details.find((d) => d.rekeningKode === '10310')?.debet).toBe(4000);

    // Idempoten: setujui ulang tidak memposting dua kali.
    const again = await rvs('POST', ['stock-reversals', id, 'approve'], {}, SPV);
    expect(again.status).toBe(200);
    expect(again.data.alreadyPosted).toBe(true);
    expect(await lokasiQty('beras')).toBe(20);

    // RL yang sudah dibalik tidak bisa diajukan lagi.
    const after = await rvs('GET', ['stock-reversals', 'check'], undefined, GUDANG, '?sourceType=RELEASE&sourceId=rl-1');
    expect(after.data.reversible).toBe(false);

    const audit = await db.collection('audit_log').findOne({ tenantId: TID, action: 'STOCK_REVERSED', entityId: 'rl-1' });
    expect(audit).toBeTruthy();
  });

  it('RL: tolak wajib alasan, batal oleh pengaju melepas klaim; MASTER boleh setujui sendiri (diaudit)', async () => {
    await postedRelease('rl-2', 'minyak', 5);
    const req = await rvs('POST', ['stock-reversals'], { sourceType: 'RELEASE', sourceId: 'rl-2', reason: 'uji tolak' }, GUDANG);
    const id = String(req.data.id);
    expect((await rvs('POST', ['stock-reversals', id, 'reject'], { reason: '' }, SPV)).status).toBe(400);
    const rej = await rvs('POST', ['stock-reversals', id, 'reject'], { reason: 'tidak valid' }, SPV);
    expect(rej.data.status).toBe('REJECTED');
    expect((await db.collection('inventory_releases').findOne({ id: 'rl-2' }))?.reversalPendingId).toBeUndefined();

    const req2 = await rvs('POST', ['stock-reversals'], { sourceType: 'RELEASE', sourceId: 'rl-2', reason: 'uji batal' }, GUDANG);
    expect(req2.status).toBe(201);
    expect((await rvs('POST', ['stock-reversals', String(req2.data.id), 'cancel'], {}, auth('u-lain', 'GUDANG'))).status).toBe(403);
    const cancel = await rvs('POST', ['stock-reversals', String(req2.data.id), 'cancel'], {}, GUDANG);
    expect(cancel.data.status).toBe('CANCELLED');

    const req3 = await rvs('POST', ['stock-reversals'], { sourceType: 'RELEASE', sourceId: 'rl-2', reason: 'darurat' }, MASTER);
    const id3 = String(req3.data.id);
    const ok = await rvs('POST', ['stock-reversals', id3, 'approve'], {}, MASTER);
    expect(ok.status).toBe(200);
    expect(ok.data.selfApprovedByMaster).toBe(true);
    expect(await lokasiQty('minyak')).toBe(20);
    // RL tanpa jurnal pemakaian dan belum ada cutover: pembalik tidak menjurnal (dinetralkan di cutover).
    expect(await db.collection('jurnal').countDocuments({ tenantId: TID, sourceType: 'AUTO_RVS_CONSUMPTION', sourceId: id3 })).toBe(0);
    const audit = await db.collection('audit_log').findOne({ tenantId: TID, action: 'STOCK_REVERSAL_SELF_APPROVED', entityId: id3 });
    expect(audit).toBeTruthy();
  });

  it('PBL berposting stok: ditolak bila rencana COMPLETED; sesudah dibalik PBL CANCELLED dengan riwayat', async () => {
    await db.collection('production_plans').insertOne({ id: 'plan-1', tenantId: TID, noDokumen: 'PLAN-1', status: 'PROCESSING' });
    await db.collection('material_issues').insertOne({
      id: 'pbl-1', tenantId: TID, noDokumen: 'PBL-1', productionPlanId: 'plan-1', status: 'COMPLETED', stockMode: 'STOCK',
      stockPostedAt: new Date(), warehouseKode: 'GKERING', lines: [], history: [],
    });
    const posted = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'FP_ISSUE', sourceId: 'pbl-1', noTransaksi: 'PBL-1', keterangan: 'PBL uji', postingDate: new Date(),
      lines: [{ lineRef: '1:telur', productId: 'telur', warehouseKode: 'GKERING', deltaQtyBase: -2, lotPolicy: { mode: 'FEFO_CONSUME' } }],
    });
    expect(posted.ok).toBe(true);
    expect(await lokasiQty('telur')).toBe(3);

    await db.collection('production_plans').updateOne({ id: 'plan-1' }, { $set: { status: 'COMPLETED' } });
    const blocked = await rvs('POST', ['stock-reversals'], { sourceType: 'FP_ISSUE', sourceId: 'pbl-1', reason: 'salah' }, GUDANG);
    expect(blocked.status).toBe(400);
    await db.collection('production_plans').updateOne({ id: 'plan-1' }, { $set: { status: 'PROCESSING' } });

    const req = await rvs('POST', ['stock-reversals'], { sourceType: 'FP_ISSUE', sourceId: 'pbl-1', reason: 'salah rencana' }, GUDANG);
    expect(req.status).toBe(201);
    const ok = await rvs('POST', ['stock-reversals', String(req.data.id), 'approve'], {}, SPV);
    expect(ok.status).toBe(200);
    expect(await lokasiQty('telur')).toBe(5);
    expect(await lotRemaining('telur')).toBe(5);
    const pbl = await db.collection('material_issues').findOne({ id: 'pbl-1' });
    expect(pbl?.status).toBe('CANCELLED');
    expect((pbl?.history as Array<Record<string, unknown>>).at(-1)).toMatchObject({ fromStatus: 'COMPLETED', toStatus: 'CANCELLED' });
  });

  it('penyesuaian: mutasi lawan membatalkan selisih; jurnal costingV2 berlawanan; penyesuaian REVERSED', async () => {
    await setFlags({ adjustmentApproval: false });
    const adj = await penyesuaian({ reasonCode: 'RUSAK', items: [{ stokId: 'minyak', qtyAktual: 17 }] }, SPV);
    expect(adj.status).toBe(200);
    expect(await lokasiQty('minyak')).toBe(17);
    const adjId = String(adj.data.id);

    const req = await rvs('POST', ['stock-reversals'], { sourceType: 'PENYESUAIAN', sourceId: adjId, reason: 'hitung ulang' }, GUDANG);
    expect(req.status).toBe(201);
    expect((req.data.lines as Array<Record<string, unknown>>)[0]).toMatchObject({ deltaQtyBase: 3 });
    const ok = await rvs('POST', ['stock-reversals', String(req.data.id), 'approve'], {}, ADMIN);
    expect(ok.status).toBe(200);
    expect(await lokasiQty('minyak')).toBe(20);

    const doc = await db.collection('penyesuaian_stok').findOne({ tenantId: TID, id: adjId });
    expect(doc?.status).toBe('REVERSED');
    const j = await db.collection('jurnal').findOne({ tenantId: TID, sourceType: 'AUTO_RVS_PENYESUAIAN', sourceId: `${String(req.data.id)}:minyak` });
    expect(j).toBeTruthy();
    const orig = await db.collection('jurnal').findOne({ tenantId: TID, sourceType: 'AUTO_PENYESUAIAN', sourceId: `${adjId}:minyak` });
    const debit = (x: Record<string, unknown> | null) => ((x?.details || []) as Array<Record<string, unknown>>).map((d) => [d.rekeningKode, d.debet]);
    const credit = (x: Record<string, unknown> | null) => ((x?.details || []) as Array<Record<string, unknown>>).map((d) => [d.rekeningKode, d.kredit]);
    expect(new Map(debit(j))).toEqual(new Map(credit(orig)));
  });

  it('transfer historis: dibalik dengan kartu lawan; baris di luar gudang produk ditolak saat pengajuan', async () => {
    await db.collection('products').insertOne({
      id: 'gula', tenantId: TID, kode: 'GULA', nama: 'gula', satuan: 'KG', itemRole: 'INGREDIENT',
      aktif: true, syncSource: 'local', gudangKode: 'GKERING', hargaBeli: 1000, stok: 0,
    });
    await grn('gula', 5, 1200);
    const qtyAt = async (lokasiKode: string) => Number((await db.collection('stok_lokasi').findOne({ tenantId: TID, stokId: 'gula', lokasiKode }))?.qty || 0);

    // Transfer lama antar-lokasi dalam Gudang Kering (label lokasi lama L001 = GKERING).
    await db.collection('transfer_stok').insertOne({
      id: 'tr-1', tenantId: TID, noTransfer: 'TR-1', tanggal: new Date(), lokasiAsal: 'GKERING', lokasiTujuan: 'L001 Rak Dapur',
      items: [{ stokId: 'gula', qty: 3, qtyBase: 3 }], userId: GUDANG.userId, fefoRelocate: [],
    });
    const posted = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'TRANSFER', sourceId: 'tr-1', noTransaksi: 'TR-1', keterangan: 'Transfer TR-1', postingDate: new Date(),
      lines: [
        { lineRef: '1:OUT', productId: 'gula', warehouseKode: 'GKERING', deltaQtyBase: -3, unitCost: 1000 },
        { lineRef: '1:IN', productId: 'gula', warehouseKode: 'L001 Rak Dapur', deltaQtyBase: 3, unitCost: 1000 },
      ],
    });
    if (!posted.ok) throw new Error(posted.error);
    expect(await qtyAt('GKERING')).toBe(5);

    const req = await rvs('POST', ['stock-reversals'], { sourceType: 'TRANSFER', sourceId: 'tr-1', reason: 'salah catat' }, GUDANG);
    expect(req.status).toBe(201);
    expect((req.data.lines as unknown[]).length).toBe(2);
    const ok = await rvs('POST', ['stock-reversals', String(req.data.id), 'approve'], {}, SPV);
    expect(ok.status).toBe(200);
    expect(await qtyAt('GKERING')).toBe(5);
    expect(await lotRemaining('gula')).toBe(5);
    expect(await avgCost('gula')).toBe(1200);
    const counter = await db.collection('stok_kartu').find({ tenantId: TID, sourceType: 'STOCK_REVERSAL', sourceId: String(req.data.id) }).toArray();
    expect(counter.map((k) => [k.lineRef, k.masuk, k.keluar]).sort()).toEqual([['1:IN', 0, 3], ['1:OUT', 3, 0]]);
    const tr = await db.collection('transfer_stok').findOne({ tenantId: TID, id: 'tr-1' });
    expect(tr).toMatchObject({ status: 'REVERSED', reversedBy: { reversalId: String(req.data.id) } });

    // Transfer lama ke Gudang Basah padahal produk sekarang milik Gudang Kering: ditolak sejak pengajuan.
    await db.collection('transfer_stok').insertOne({
      id: 'tr-2', tenantId: TID, noTransfer: 'TR-2', tanggal: new Date(), lokasiAsal: 'GKERING', lokasiTujuan: 'GBASAH',
      items: [{ stokId: 'gula', qty: 1, qtyBase: 1 }], userId: GUDANG.userId,
    });
    await db.collection('stok_kartu').insertOne({
      id: 'k-tr-2', tenantId: TID, stokId: 'gula', lokasiKode: 'GBASAH', sourceType: 'TRANSFER', sourceId: 'tr-2', lineRef: '1:IN', masuk: 1, keluar: 0, hargaSatuan: 1200,
    });
    const blocked = await rvs('POST', ['stock-reversals'], { sourceType: 'TRANSFER', sourceId: 'tr-2', reason: 'salah gudang' }, GUDANG);
    expect(blocked.status).toBe(400);
    expect(String(blocked.data.error)).toMatch(/gudang produk sudah berubah/);
  });

  it('kunci periode dengan tanggal server menolak persetujuan', async () => {
    await postedRelease('rl-3', 'telur', 1);
    const req = await rvs('POST', ['stock-reversals'], { sourceType: 'RELEASE', sourceId: 'rl-3', reason: 'uji kunci' }, GUDANG);
    const until = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { periodLockedUntil: until } });
    const locked = await rvs('POST', ['stock-reversals', String(req.data.id), 'approve'], {}, SPV);
    expect(locked.status).toBe(423);
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $unset: { periodLockedUntil: '' } });
    expect(await lokasiQty('telur')).toBe(4);
  });

  it('pemakaian historis tanpa jurnal bersih terhadap RL yang dibalik', async () => {
    const T2 = 'it-f5-rvs-legacy';
    await db.collection('stok_kartu').insertMany([
      { tenantId: T2, stokId: 'x', sourceType: 'RELEASE', sourceId: 'rl-a', keluar: 2, masuk: 0, hargaSatuan: 1000, costSource: 'AVG' },
      { tenantId: T2, stokId: 'x', sourceType: 'RELEASE', sourceId: 'rl-b', keluar: 3, masuk: 0, hargaSatuan: 1000, costSource: 'AVG' },
      { tenantId: T2, stokId: 'x', sourceType: 'STOCK_REVERSAL', sourceId: 'rvs-a', reversalOfSourceType: 'RELEASE', reversalOfSourceId: 'rl-a', keluar: 0, masuk: 2, hargaSatuan: 1000, costSource: 'LINE' },
    ]);
    await db.collection('products').insertOne({ id: 'x', tenantId: T2, itemRole: 'INGREDIENT' });
    expect(await unjournaledConsumptionValue(db, T2)).toBe(3000);
  });
});
