/**
 * Fase 3.2 — QC lot (flag tenant lotQcRequired): GRN → lot karantina, FEFO/guard keras mengecualikan
 * lot tertahan, inspeksi (lolos/split/tolak, suhu gudang basah, SoD), RTV & pemusnahan lot ditolak.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { postStockMovements } from '@/lib/stock-ledger';
import { peekFefoLotNo } from '@/lib/stock-ledger/lot-consume';
import {
  claimRejectedLotForRtv,
  inspectIngredientLot,
  loadLotQcHeldQtyByProduct,
  loadRejectedLotForFollowUp,
  releaseRejectedLotRtvClaim,
  summarizeLotQc,
} from '@/lib/stock-ledger/lot-qc';
import { disposeRejectedLot } from '@/lib/stock-ledger/lot-qc-dispose';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';
import { applyVendorReturnStock } from '@/lib/api/vendor-return-stock';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-32';
type Json = Record<string, unknown>;

const PRODUCT_IDS = ['legacy', 'q1', 'mix', 'cum', 'insp', 'split', 'wet', 'rtv', 'disp', 'cc', 'sum'];

const product = (id: string, extra: Json = {}) => ({
  id, tenantId: TID, kode: id.toUpperCase(), nama: `Produk ${id}`, satuan: 'KG', itemRole: 'INGREDIENT', aktif: true,
  syncSource: 'local', gudangKode: 'GKERING', hargaBeli: 10000, stok: 0,
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  ...extra,
});

const receiver = { userId: 'u-gudang', userName: 'Penerima' } as never;
const supervisor = { userId: 'u-spv', userName: 'Supervisor', role: 'SUPERVISOR' };

let seq = 0;

describe.skipIf(!MongoMemoryReplSet)('Fase 3.2 QC lot (Mongo replica set)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  const setFlag = async (on: boolean) => {
    await db.collection('tenant_settings').updateOne(
      { tenantId: TID },
      { $set: { 'features.lotQcRequired': on } },
      { upsert: true },
    );
  };
  const stockOf = async (stokId: string, lokasiKode = 'GKERING') => Number(
    (await db.collection('stok_lokasi').findOne({ tenantId: TID, stokId, lokasiKode }))?.qty ?? 0,
  );
  const lotById = (id: string) => db.collection('ingredient_lots').findOne({ tenantId: TID, id }) as Promise<Json | null>;

  const receive = async (stokId: string, qty: number) => {
    seq += 1;
    const grn = {
      id: `grn-${seq}`, tenantId: TID, noGRN: `GRN-32-${seq}`, noDO: `DO-32-${seq}`, vendorTenantId: 'v1',
      items: [{ lineId: 'l0', localStokId: stokId, vendorKode: stokId.toUpperCase(), qtyOrdered: qty, qtyBase: qty, satuan: 'KG', harga: 10000 }],
    };
    const res = await applyGrnStockPosting(db, TID, grn as never, [], undefined, receiver);
    expect(res.error).toBeUndefined();
    const lot = await db.collection('ingredient_lots').findOne({ grnId: grn.id });
    return lot as unknown as Json & { id: string; lotNo: string };
  };

  const adjustIn = (productId: string, qty: number) => postStockMovements(db, undefined, {
    tenantId: TID, sourceType: 'PENYESUAIAN', sourceId: `adj-${++seq}`, noTransaksi: `PS-32-${seq}`, keterangan: 'hitung fisik',
    lines: [{ lineRef: '1', productId, warehouseKode: 'GKERING', deltaQtyBase: qty, binPolicy: 'NONE', lotPolicy: { mode: 'VARIANCE' } }],
  } as never);

  const issue = (productId: string, qtys: number[], lotPolicy: Json = { mode: 'FEFO_CONSUME' }) => postStockMovements(db, undefined, {
    tenantId: TID, sourceType: 'RELEASE', sourceId: `rl-${++seq}`, noTransaksi: `RL-32-${seq}`, keterangan: 'issue',
    lines: qtys.map((q, i) => ({ lineRef: `${i + 1}`, productId, warehouseKode: 'GKERING', deltaQtyBase: -q, lotPolicy })),
  } as never);

  const inspect = (lotId: string, body: Json, actor: Json = supervisor) => inspectIngredientLot(db, {
    tenantId: TID, lotId, kondisi: 'BAIK', ...body, actor,
  } as never);

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('lot_qc_it');
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });
    await db.collection('products').insertMany(PRODUCT_IDS.map((id) => product(id, id === 'wet' ? { gudangKode: 'GBASAH' } : {})));
    await db.collection('product_uom').insertMany(PRODUCT_IDS.map((id) => ({
      id: `u-${id}`, tenantId: TID, productId: id, satuan: 'KG', isBase: true, factorToBase: 1, aktif: true, sortOrder: 0,
    })));
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  beforeEach(async () => {
    await db.collection('tenant_settings').deleteMany({ tenantId: TID });
  });

  it('flag off: lot GRN langsung tersedia (jalur lama)', async () => {
    const lot = await receive('legacy', 2);
    expect(lot.qcStatus).toBeUndefined();
    expect(lot.receivedByUserId).toBe('u-gudang');
    const res = await issue('legacy', [2]);
    expect(res.ok).toBe(true);
    expect(await stockOf('legacy')).toBe(0);
  });

  it('flag on: lot GRN karantina — FEFO tidak pernah memilihnya; keluar/transfer diblokir keras', async () => {
    await setFlag(true);
    const lot = await receive('q1', 3);
    expect(lot).toMatchObject({ qcStatus: 'QUARANTINE', receivedByUserId: 'u-gudang' });
    expect(await peekFefoLotNo(db, { tenantId: TID, stokId: 'q1', warehouseKode: 'GKERING' })).toBeNull();

    const blocked = await issue('q1', [1]);
    expect(blocked.ok).toBe(false);
    expect(JSON.stringify(blocked)).toMatch(/karantina QC/);
    expect(JSON.stringify(blocked)).toMatch(/Selesaikan pemeriksaan di menu QC Penerimaan/);

    const preferred = await issue('q1', [1], { mode: 'FEFO_CONSUME', preferredLotNo: lot.lotNo });
    expect(preferred.ok).toBe(false);

    const moved = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'TRANSFER', sourceId: 'tr-32', noTransaksi: 'TR-32', keterangan: 'tr',
      lines: [{ lineRef: '1:OUT', productId: 'q1', warehouseKode: 'GKERING', deltaQtyBase: -1, lotPolicy: { mode: 'RELOCATE', toWarehouseKode: 'DAPUR1' } }],
    } as never);
    expect(moved.ok).toBe(false);

    expect(await stockOf('q1')).toBe(3);
    expect((await lotById(lot.id))?.qtyRemaining).toBe(3);
    expect(await db.collection('stok_kartu').countDocuments({ tenantId: TID, stokId: 'q1', qtyChange: { $lt: 0 } })).toBe(0);
  });

  it('stok campuran: hanya lot lolos yang terpakai; sisanya (karantina) diblokir', async () => {
    const adj = await adjustIn('mix', 2);
    expect(adj.ok).toBe(true);
    await setFlag(true);
    const quarantined = await receive('mix', 3);

    const ok = await issue('mix', [2]);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const takenIds = ok.lines[0].lot?.allocations.map((a) => a.batchId) ?? [];
    expect(takenIds.length).toBeGreaterThan(0);
    expect(takenIds).not.toContain(quarantined.id);
    expect((await lotById(quarantined.id))?.qtyRemaining).toBe(3);

    const more = await issue('mix', [1]);
    expect(more.ok).toBe(false);
    expect(await stockOf('mix')).toBe(3);
  });

  it('guard kumulatif antar baris dalam satu dokumen', async () => {
    await adjustIn('cum', 2);
    await setFlag(true);
    await receive('cum', 3);
    const res = await issue('cum', [1.5, 1.5]);
    expect(res.ok).toBe(false);
    expect(await stockOf('cum')).toBe(5);
  });

  it('inspeksi: SoD penerima, lolos → dirilis & bisa dipakai, inspeksi ulang ditolak', async () => {
    await setFlag(true);
    const lot = await receive('insp', 3);

    const sod = await inspect(lot.id, { qtyPassed: 3, qtyFailed: 0 }, { userId: 'u-gudang', userName: 'Penerima', role: 'SUPERVISOR' });
    expect(sod).toMatchObject({ ok: false, status: 403 });

    const res = await inspect(lot.id, { qtyPassed: 3, qtyFailed: 0, catatan: 'ok' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.inspection).toMatchObject({ hasil: 'LOLOS', qtyPassed: 3, qtyFailed: 0, receivedByUserId: 'u-gudang' });
    expect(res.inspection.noInspeksi).toMatch(/^QCI/);
    expect(await lotById(lot.id)).toMatchObject({ qcStatus: 'RELEASED', noInspeksi: res.inspection.noInspeksi });
    expect(await db.collection('lot_inspections').countDocuments({ tenantId: TID, lotId: lot.id })).toBe(1);
    expect(await db.collection('audit_log').countDocuments({ tenantId: TID, action: 'LOT_QC_INSPECTION', entityId: lot.id })).toBe(1);

    const again = await inspect(lot.id, { qtyPassed: 3, qtyFailed: 0 });
    expect(again).toMatchObject({ ok: false, status: 409 });

    expect((await issue('insp', [3])).ok).toBe(true);
  });

  it('inspeksi sebagian: qty gagal dipisah jadi lot DITOLAK; hanya qty lolos yang bisa keluar', async () => {
    await setFlag(true);
    const lot = await receive('split', 5);

    expect(await inspect(lot.id, { qtyPassed: 3, qtyFailed: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(await inspect(lot.id, { qtyPassed: 3, qtyFailed: 2, alasanTolak: 'busuk' })).toMatchObject({ ok: false, status: 400 });
    expect(await inspect(lot.id, { qtyPassed: 3, qtyFailed: 2, kondisi: 'BUSUK_BERJAMUR' })).toMatchObject({ ok: false, status: 400 });

    const res = await inspect(lot.id, { qtyPassed: 3, qtyFailed: 2, kondisi: 'BUSUK_BERJAMUR', alasanTolak: 'busuk di dasar karung' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.inspection.hasil).toBe('SEBAGIAN');
    expect(await lotById(lot.id)).toMatchObject({ qcStatus: 'RELEASED', qty: 3, qtyRemaining: 3 });
    const rejected = await lotById(res.rejectedLot!.id);
    expect(rejected).toMatchObject({
      qcStatus: 'REJECTED', qcRejectStatus: 'PENDING', qty: 2, qtyRemaining: 2,
      lotNo: `${lot.lotNo}-R`, qcSplitFromLotId: lot.id, qcRejectReason: 'busuk di dasar karung',
    });
    expect(await stockOf('split')).toBe(5);

    expect((await issue('split', [4])).ok).toBe(false);
    const ok = await issue('split', [3]);
    expect(ok.ok).toBe(true);
    expect((await lotById(res.rejectedLot!.id))?.qtyRemaining).toBe(2);
  });

  it('gudang basah: suhu wajib & rentang divalidasi', async () => {
    await setFlag(true);
    const lot = await receive('wet', 2);
    expect(lot.warehouseKode).toBe('GBASAH');
    expect(await inspect(lot.id, { qtyPassed: 2, qtyFailed: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(await inspect(lot.id, { qtyPassed: 2, qtyFailed: 0, suhuC: 90 })).toMatchObject({ ok: false, status: 400 });
    const res = await inspect(lot.id, { qtyPassed: 2, qtyFailed: 0, suhuC: 3.5 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.inspection.suhuC).toBe(3.5);
  });

  it('lot ditolak: klaim RTV eksklusif, hapus draft mengembalikan, posting RTV mengonsumsi lot itu saja', async () => {
    await setFlag(true);
    const lot = await receive('rtv', 2);
    const res = await inspect(lot.id, { qtyPassed: 0, qtyFailed: 2, kondisi: 'KEMASAN_RUSAK', alasanTolak: 'sobek' });
    expect(res.ok).toBe(true);
    expect(await lotById(lot.id)).toMatchObject({ qcStatus: 'REJECTED', qcRejectStatus: 'PENDING' });

    const plainLine = {
      lineId: 'x1', localStokId: 'rtv', qty: 2, satuan: 'KG', gudangKode: 'GKERING', harga: 10000, lotNo: lot.lotNo,
    };
    const plain = await applyVendorReturnStock(db, TID, 'RTV-PLAIN', [plainLine] as never, undefined, { returnId: 'rtv-plain' });
    expect(plain.error).toMatch(/ditolak QC/);

    const claim = { tenantId: TID, lotId: lot.id, rtvId: 'rtv-1', noReturn: 'RTV-1' };
    expect(await claimRejectedLotForRtv(db, undefined, claim)).toBe(true);
    expect(await claimRejectedLotForRtv(db, undefined, { ...claim, rtvId: 'rtv-2', noReturn: 'RTV-2' })).toBe(false);
    expect(await loadRejectedLotForFollowUp(db, TID, lot.id)).toMatchObject({ status: 409 });

    await releaseRejectedLotRtvClaim(db, undefined, { tenantId: TID, lotId: lot.id, rtvId: 'rtv-1' });
    expect(await lotById(lot.id)).toMatchObject({ qcRejectStatus: 'PENDING' });
    expect(await claimRejectedLotForRtv(db, undefined, claim)).toBe(true);

    const posted = await applyVendorReturnStock(db, TID, 'RTV-1', [{ ...plainLine, qcLotId: lot.id }] as never, undefined, { returnId: 'rtv-1' });
    expect(posted.error).toBeUndefined();
    expect(posted.lotConsume?.[0]).toMatchObject({ allocated: 2, shortfall: 0 });
    expect((await lotById(lot.id))?.qtyRemaining).toBe(0);
    expect(await stockOf('rtv')).toBe(0);

    const restored = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'VENDOR_RETURN_REJECTED', sourceId: 'rtv-1', noTransaksi: 'RTV-1', keterangan: 'vendor tolak',
      lines: [{
        lineRef: '1:RESTORE', productId: 'rtv', warehouseKode: 'GKERING', deltaQtyBase: 2,
        lotPolicy: { mode: 'RESTORE', restores: posted.lotConsume![0].allocations },
      }],
    } as never);
    expect(restored.ok).toBe(true);
    const reopened = await lotById(lot.id);
    expect(reopened).toMatchObject({ qtyRemaining: 2, qcStatus: 'REJECTED', qcRejectStatus: 'PENDING' });
    expect(reopened?.qcRejectRtvId).toBeUndefined();
    expect((await issue('rtv', [1])).ok).toBe(false);

    const extra = await adjustIn('rtv', 5);
    expect(extra.ok).toBe(true);
    const spill = await applyVendorReturnStock(db, TID, 'RTV-SPILL', [{ ...plainLine, qty: 4, qcLotId: lot.id }] as never, undefined, { returnId: 'rtv-spill' });
    expect(spill.error).toMatch(/hanya boleh mengambil lot ditolak/);
    expect(await stockOf('rtv')).toBe(7);
    expect((await lotById(lot.id))?.qtyRemaining).toBe(2);

    const only = await applyVendorReturnStock(db, TID, 'RTV-ONLY', [{ ...plainLine, qcLotId: lot.id }] as never, undefined, { returnId: 'rtv-only' });
    expect(only.error).toBeUndefined();
    expect(only.lotConsume?.[0]).toMatchObject({ allocated: 2, shortfall: 0 });
    expect(await stockOf('rtv')).toBe(5);
    expect((await lotById(lot.id))?.qtyRemaining).toBe(0);
  });

  it('RTV lot ditolak yang sudah kedaluwarsa tetap hanya mengambil lot itu, penuh', async () => {
    await db.collection('products').insertOne(product('rtvexp'));
    await db.collection('product_uom').insertOne({
      id: 'u-rtvexp', tenantId: TID, productId: 'rtvexp', satuan: 'KG', isBase: true, factorToBase: 1, aktif: true, sortOrder: 0,
    });
    await setFlag(true);
    const lot = await receive('rtvexp', 2);
    const rejected = await inspect(lot.id, { qtyPassed: 0, qtyFailed: 2, kondisi: 'BUSUK_BERJAMUR', alasanTolak: 'busuk' });
    expect(rejected.ok).toBe(true);
    await db.collection('ingredient_lots').updateOne(
      { tenantId: TID, id: lot.id },
      { $set: { expiryDate: '2020-01-01', status: 'EXPIRED' } },
    );
    const line = {
      lineId: 'x-exp', localStokId: 'rtvexp', qty: 2, satuan: 'KG', gudangKode: 'GKERING', harga: 10000,
      lotNo: lot.lotNo, qcLotId: lot.id,
    };
    const posted = await applyVendorReturnStock(db, TID, 'RTV-EXP', [line] as never, undefined, { returnId: 'rtv-exp' });
    expect(posted.error).toBeUndefined();
    expect(posted.lotConsume?.[0]).toMatchObject({ allocated: 2, shortfall: 0 });
    expect((await lotById(lot.id))?.qtyRemaining).toBe(0);
    expect(await stockOf('rtvexp')).toBe(0);
  });

  it('pemusnahan lot ditolak: stok keluar, status DISPOSED, jurnal kerugian, tidak bisa diulang', async () => {
    await setFlag(true);
    const lot = await receive('disp', 4);
    const res = await inspect(lot.id, { qtyPassed: 1, qtyFailed: 3, kondisi: 'BUSUK_BERJAMUR', alasanTolak: 'busuk' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rejectedId = res.rejectedLot!.id;

    expect(await disposeRejectedLot(db, { tenantId: TID, lotId: rejectedId, reason: '', actor: supervisor })).toMatchObject({ ok: false, status: 400 });
    const disposed = await disposeRejectedLot(db, { tenantId: TID, lotId: rejectedId, reason: 'vendor menolak retur', actor: supervisor });
    expect(disposed).toMatchObject({ ok: true, qty: 3, amount: 30000 });
    if (!disposed.ok) return;
    expect(disposed.noDokumen).toMatch(/^QCD/);
    expect(await stockOf('disp')).toBe(1);
    const after = await lotById(rejectedId);
    expect(after).toMatchObject({ qtyRemaining: 0, qcRejectStatus: 'DISPOSED' });
    expect((after?.qcDisposal as Json)?.noDokumen).toBe(disposed.noDokumen);
    expect(await db.collection('jurnal').countDocuments({ tenantId: TID, sourceType: 'AUTO_QC_DISPOSAL', sourceId: rejectedId })).toBe(1);
    expect((await lotById(lot.id))?.qtyRemaining).toBe(1);

    const again = await disposeRejectedLot(db, { tenantId: TID, lotId: rejectedId, reason: 'ulang', actor: supervisor });
    expect(again.ok).toBe(false);
  });

  it('hitung fisik turun: lot lolos dipakai dulu, lalu lot tertahan; tidak pernah diblokir', async () => {
    await adjustIn('cc', 2);
    await setFlag(true);
    const quarantined = await receive('cc', 3);
    const down = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'PENYESUAIAN', sourceId: 'cc-down', noTransaksi: 'PS-CC', keterangan: 'hitung fisik',
      lines: [{ lineRef: '1', productId: 'cc', warehouseKode: 'GKERING', deltaQtyBase: -3, binPolicy: 'NONE', lotPolicy: { mode: 'VARIANCE' } }],
    } as never);
    expect(down.ok).toBe(true);
    expect(await stockOf('cc')).toBe(2);
    expect((await lotById(quarantined.id))?.qtyRemaining).toBe(2);

    // Hitung naik mengembalikan qty lot karantina yang tadi terpakai dulu (tidak lolos tanpa inspeksi).
    const up = await adjustIn('cc', 1);
    expect(up.ok).toBe(true);
    expect((await lotById(quarantined.id))?.qtyRemaining).toBe(3);
    expect((await issue('cc', [1])).ok).toBe(false);

    const upMore = await adjustIn('cc', 2);
    expect(upMore.ok).toBe(true);
    expect((await lotById(quarantined.id))?.qtyRemaining).toBe(3);
    expect(await stockOf('cc')).toBe(5);
    expect((await issue('cc', [2])).ok).toBe(true);
  });

  it('ringkasan & qty tertahan per produk (dasar prefill RL / Ops)', async () => {
    await setFlag(true);
    const lot = await receive('sum', 4);
    const held = await loadLotQcHeldQtyByProduct(db, TID, ['sum', 'legacy'], 'GKERING');
    expect(held.get('sum')).toBe(4);
    expect(held.get('legacy') ?? 0).toBe(0);
    const summary = await summarizeLotQc(db, TID);
    expect(summary.quarantineLots).toBeGreaterThanOrEqual(1);
    expect(summary.rejectedPending).toBeGreaterThanOrEqual(0);
    expect(summary.quarantineConsumed).toBe(0);
    expect((await lotById(lot.id))?.qcStatus).toBe('QUARANTINE');
  });
});
