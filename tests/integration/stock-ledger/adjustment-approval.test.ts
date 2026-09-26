/**
 * Fase 5 — penyesuaian dengan maker-checker (flag adjustmentApproval): draft → ajukan → setujui oleh orang lain.
 * Snapshot qty sistem saat hitung dimulai; mutasi setelah snapshot tetap berlaku. Kode alasan wajib.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { postStockMovements, reconcileProductStockFromLedger } from '@/lib/stock-ledger';
import { handlePenyesuaian } from '@/lib/api/handlers/inventory-penyesuaian';
import type { AuthContext } from '@/types/auth';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-f5-adj';

const auth = (userId: string, role: string, isMaster = false): AuthContext => ({
  userId, email: `${userId}@x`, name: userId, role, tenantId: TID, tenantName: TID, isMaster,
});
const GUDANG = auth('u-gudang', 'GUDANG');
const SPV = auth('u-spv', 'SUPERVISOR');
const SPV2 = auth('u-spv2', 'SUPERVISOR');
const ADMIN = auth('u-admin', 'ADMIN');
const MASTER = auth('u-master', 'MASTER', true);

describe.skipIf(!MongoMemoryReplSet)('Fase 5 penyesuaian maker-checker', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;
  let seq = 0;

  const call = async (method: string, path: string[], body: unknown, who: AuthContext) => {
    const url = new URL(`http://x/api/${path.join('/')}`);
    const request = Object.assign(new Request(url), { cookies: { get: () => ({ value: TID }) } });
    const res = await handlePenyesuaian({
      db, route: `/${path.join('/')}`, method, path, body, url, auth: who, request,
    });
    if (!res) throw new Error('handler tidak menangani route');
    return { status: res.status, data: await res.json() as Record<string, unknown> };
  };

  const lokasiQty = async (stokId: string) => Number((await db.collection('stok_lokasi').findOne({ tenantId: TID, stokId, lokasiKode: 'GKERING' }))?.qty || 0);

  const move = async (stokId: string, delta: number) => {
    seq += 1;
    const res = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: delta > 0 ? 'GRN' : 'RELEASE', sourceId: `mv-${seq}`, noTransaksi: `MV-${seq}`,
      keterangan: 'seed', postingDate: new Date(), enforceLedger: false,
      lines: [{ lineRef: '1', productId: stokId, warehouseKode: 'GKERING', deltaQtyBase: delta, unitCost: 1000 }],
    });
    if (!res.ok) throw new Error(res.error);
  };

  const setFlag = (on: boolean) => db.collection('tenant_settings').updateOne(
    { tenantId: TID },
    { $set: { 'features.adjustmentApproval': on } },
    { upsert: true },
  );

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('adjustment_approval_it');
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });
    for (const id of ['gula', 'garam']) {
      await db.collection('products').insertOne({
        id, tenantId: TID, kode: id.toUpperCase(), nama: id, satuan: 'KG', itemRole: 'INGREDIENT',
        aktif: true, syncSource: 'local', gudangKode: 'GKERING', hargaBeli: 1000, stok: 0,
      });
      await db.collection('product_uom').insertOne({
        id: `u-${id}`, tenantId: TID, productId: id, satuan: 'KG', isBase: true, factorToBase: 1, aktif: true, sortOrder: 0,
      });
    }
    await move('gula', 10);
    await move('garam', 5);
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('tanpa approval: kode alasan wajib, posting langsung oleh Supervisor, GUDANG ditolak', async () => {
    await setFlag(false);
    const noReason = await call('POST', ['stok', 'penyesuaian'], { items: [{ stokId: 'garam', qtyAktual: 4 }] }, SPV);
    expect(noReason.status).toBe(400);
    const lainnya = await call('POST', ['stok', 'penyesuaian'], { reasonCode: 'LAINNYA', items: [{ stokId: 'garam', qtyAktual: 4 }] }, SPV);
    expect(lainnya.status).toBe(400);
    const gudang = await call('POST', ['stok', 'penyesuaian'], { reasonCode: 'RUSAK', items: [{ stokId: 'garam', qtyAktual: 4 }] }, GUDANG);
    expect(gudang.status).toBe(403);

    const res = await call('POST', ['stok', 'penyesuaian'], { reasonCode: 'RUSAK', userName: 'palsu', items: [{ stokId: 'garam', qtyAktual: 4 }] }, SPV);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('POSTED');
    expect(res.data.userName).toBe('u-spv');
    expect(await lokasiQty('garam')).toBe(4);
    const j = await db.collection('jurnal').findOne({ tenantId: TID, sourceType: 'AUTO_PENYESUAIAN', sourceId: `${String(res.data.id)}:garam` });
    expect(j).toBeTruthy();
  });

  it('dengan approval: snapshot saat hitung, mutasi sesudahnya dipertahankan, pembuat tidak boleh menyetujui', async () => {
    await setFlag(true);
    const draft = await call('POST', ['stok', 'penyesuaian'], { items: [{ stokId: 'gula' }] }, GUDANG);
    expect(draft.status).toBe(200);
    expect(draft.data.status).toBe('DRAFT');
    const id = String(draft.data.id);
    const items = draft.data.items as Array<Record<string, unknown>>;
    expect(items[0].qtySistem).toBe(10);
    expect(items[0].qtyAktual).toBeNull();

    // Tidak bisa diajukan sebelum qty hitung & alasan diisi.
    expect((await call('POST', ['stok', 'penyesuaian', id, 'submit'], {}, GUDANG)).status).toBe(400);

    // Gudang menghitung 9 (dari snapshot 10) — lalu ada pemakaian 3 sebelum disetujui.
    const edit = await call('PUT', ['stok', 'penyesuaian', id], { reasonCode: 'OPNAME', items: [{ stokId: 'gula', qtyAktual: 9 }] }, GUDANG);
    expect(edit.status).toBe(200);
    expect((edit.data.items as Array<Record<string, unknown>>)[0].qtySistem).toBe(10);
    await move('gula', -3);
    expect(await lokasiQty('gula')).toBe(7);

    const submitted = await call('POST', ['stok', 'penyesuaian', id, 'submit'], {}, GUDANG);
    expect(submitted.status).toBe(200);
    expect(submitted.data.status).toBe('PENDING_APPROVAL');

    // GUDANG tidak punya role setuju; Supervisor yang mengajukan sendiri juga ditolak.
    expect((await call('POST', ['stok', 'penyesuaian', id, 'approve'], {}, GUDANG)).status).toBe(403);

    const approved = await call('POST', ['stok', 'penyesuaian', id, 'approve'], {}, SPV);
    expect(approved.status).toBe(200);
    expect(approved.data.status).toBe('POSTED');
    const line = (approved.data.items as Array<Record<string, unknown>>)[0];
    expect(line.selisih).toBe(-1);
    expect(line.qtySistemPosting).toBe(7);
    expect(line.qtyAkhir).toBe(6);
    expect(await lokasiQty('gula')).toBe(6);
    const kartu = await db.collection('stok_kartu').findOne({ tenantId: TID, sourceType: 'PENYESUAIAN', sourceId: id });
    expect(kartu?.keluar).toBe(1);

    // Tidak bisa disetujui dua kali.
    expect((await call('POST', ['stok', 'penyesuaian', id, 'approve'], {}, SPV2)).status).toBe(400);
  });

  it('maker-checker ketat: Supervisor/Admin tidak boleh menyetujui dokumen sendiri; MASTER boleh dengan audit', async () => {
    await setFlag(true);
    const own = await call('POST', ['stok', 'penyesuaian'], { reasonCode: 'HILANG', submit: true, items: [{ stokId: 'garam', qtyAktual: 3 }] }, ADMIN);
    expect(own.status).toBe(200);
    expect(own.data.status).toBe('PENDING_APPROVAL');
    const self = await call('POST', ['stok', 'penyesuaian', String(own.data.id), 'approve'], {}, ADMIN);
    expect(self.status).toBe(403);

    const rejectNoReason = await call('POST', ['stok', 'penyesuaian', String(own.data.id), 'reject'], {}, SPV);
    expect(rejectNoReason.status).toBe(400);
    const rejected = await call('POST', ['stok', 'penyesuaian', String(own.data.id), 'reject'], { reason: 'Hitung ulang' }, SPV);
    expect(rejected.data.status).toBe('REJECTED');
    expect(await lokasiQty('garam')).toBe(4);

    const byMaster = await call('POST', ['stok', 'penyesuaian'], { reasonCode: 'SALAH_INPUT', submit: true, items: [{ stokId: 'garam', qtyAktual: 5 }] }, MASTER);
    const approvedByMaster = await call('POST', ['stok', 'penyesuaian', String(byMaster.data.id), 'approve'], {}, MASTER);
    expect(approvedByMaster.status).toBe(200);
    expect(approvedByMaster.data.selfApprovedByMaster).toBe(true);
    expect(await lokasiQty('garam')).toBe(5);
    const audit = await db.collection('audit_log').findOne({ tenantId: TID, action: 'STOCK_ADJUSTMENT_SELF_APPROVED', entityId: String(byMaster.data.id) });
    expect(audit).toBeTruthy();
  });

  it('pengubah draft ikut dihitung pembuat: tidak boleh menyetujui', async () => {
    await setFlag(true);
    const draft = await call('POST', ['stok', 'penyesuaian'], { items: [{ stokId: 'garam' }] }, GUDANG);
    const id = String(draft.data.id);
    const edit = await call('PUT', ['stok', 'penyesuaian', id], { reasonCode: 'OPNAME', items: [{ stokId: 'garam', qtyAktual: 4 }] }, SPV);
    expect(edit.status).toBe(200);
    expect(edit.data.editorIds).toEqual(['u-spv']);
    const stale = await call('PUT', ['stok', 'penyesuaian', id], { updatedAt: draft.data.updatedAt, items: [{ stokId: 'garam', qtyAktual: 1 }] }, GUDANG);
    expect(stale.status).toBe(409);
    expect((await call('POST', ['stok', 'penyesuaian', id, 'submit'], {}, GUDANG)).status).toBe(200);

    const byEditor = await call('POST', ['stok', 'penyesuaian', id, 'approve'], {}, SPV);
    expect(byEditor.status).toBe(403);
    const byOther = await call('POST', ['stok', 'penyesuaian', id, 'approve'], {}, SPV2);
    expect(byOther.status).toBe(200);
    expect(byOther.data.status).toBe('POSTED');
  });

  it('pembatalan draft dan penolakan produk ganda', async () => {
    await setFlag(true);
    const dup = await call('POST', ['stok', 'penyesuaian'], { items: [{ stokId: 'gula' }, { stokId: 'gula' }] }, GUDANG);
    expect(dup.status).toBe(400);
    const draft = await call('POST', ['stok', 'penyesuaian'], { items: [{ stokId: 'gula', qtyAktual: 1 }] }, GUDANG);
    const cancelled = await call('POST', ['stok', 'penyesuaian', String(draft.data.id), 'cancel'], {}, GUDANG);
    expect(cancelled.data.status).toBe('CANCELLED');
    expect((await call('POST', ['stok', 'penyesuaian', String(draft.data.id), 'submit'], {}, GUDANG)).status).toBe(400);
  });

  it('kunci periode: persetujuan ditolak saat tanggal server masuk periode terkunci', async () => {
    await setFlag(true);
    const draft = await call('POST', ['stok', 'penyesuaian'], { reasonCode: 'OPNAME', submit: true, items: [{ stokId: 'gula', qtyAktual: 6 }] }, GUDANG);
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { periodLockedUntil: new Date(Date.now() + 86_400_000).toISOString() } });
    const res = await call('POST', ['stok', 'penyesuaian', String(draft.data.id), 'approve'], {}, SPV);
    expect(res.status).toBe(423);
    await setFlag(false);
    const past = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { periodLockedUntil: past } });
    const invalidDate = await call('POST', ['stok', 'penyesuaian'], { tanggal: 'bukan-tanggal', reasonCode: 'OPNAME', items: [{ stokId: 'gula', qtyAktual: 6 }] }, SPV);
    expect(invalidDate.status).toBe(400);
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $unset: { periodLockedUntil: '' } });
  });

  it('koreksi saldo kartu negatif: ditolak saat approval aktif, tercatat atas nama pelaku saat nonaktif', async () => {
    await db.collection('products').insertOne({
      id: 'minus', tenantId: TID, kode: 'MINUS', nama: 'minus', satuan: 'KG', itemRole: 'INGREDIENT',
      aktif: true, syncSource: 'local', gudangKode: 'GKERING', hargaBeli: 1000, stok: 0,
    });
    await db.collection('stok_kartu').insertOne({
      id: 'k-minus', tenantId: TID, stokId: 'minus', lokasiKode: 'GKERING', masuk: 0, keluar: 2,
      sourceType: 'SEED', sourceId: 'seed-minus', lineRef: '1', tanggal: new Date(), createdAt: new Date(),
    });
    const product = await db.collection('products').findOne({ tenantId: TID, id: 'minus' });
    const actor = { userId: 'u-spv', userName: 'u-spv' };

    await setFlag(true);
    const blocked = await reconcileProductStockFromLedger(db, TID, product as never, { clearNegative: true, actor });
    expect('error' in blocked && blocked.error).toMatch(/Persetujuan penyesuaian aktif/);
    expect(await db.collection('penyesuaian_stok').countDocuments({ tenantId: TID, 'items.stokId': 'minus' })).toBe(0);

    await setFlag(false);
    const cleared = await reconcileProductStockFromLedger(db, TID, product as never, { clearNegative: true, actor });
    expect('error' in cleared).toBe(false);
    const doc = await db.collection('penyesuaian_stok').findOne({ tenantId: TID, 'items.stokId': 'minus' });
    expect(doc?.status).toBe('POSTED');
    expect(doc?.userId).toBe('u-spv');
  });

  it('penyesuaian ditolak bila SKU masih punya stok nyata di gudang non-home', async () => {
    await setFlag(false);
    await db.collection('stok_lokasi').insertOne({ id: 'stray-garam', tenantId: TID, stokId: 'garam', lokasiKode: 'GBASAH', qty: 2 });
    const before = await lokasiQty('garam');
    const res = await call('POST', ['stok', 'penyesuaian'], { reasonCode: 'OPNAME', items: [{ stokId: 'garam', qtyAktual: 1 }] }, SPV);
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toMatch(/gudang lain/);
    expect(await db.collection('stok_lokasi').countDocuments({ tenantId: TID, stokId: 'garam', lokasiKode: 'GBASAH' })).toBe(1);
    expect(await lokasiQty('garam')).toBe(before);
    await db.collection('stok_lokasi').deleteOne({ id: 'stray-garam' });
  });

  it('kartu mencatat qty mutasi dalam satuan input, bukan qty hitung fisik', async () => {
    await setFlag(false);
    await db.collection('products').insertOne({
      id: 'tepung', tenantId: TID, kode: 'TEPUNG', nama: 'tepung', satuan: 'KG', itemRole: 'INGREDIENT',
      aktif: true, syncSource: 'local', gudangKode: 'GKERING', hargaBeli: 1000, stok: 0,
    });
    await db.collection('product_uom').insertMany([
      { id: 'u-tepung', tenantId: TID, productId: 'tepung', satuan: 'KG', isBase: true, factorToBase: 1, aktif: true, sortOrder: 0 },
      { id: 'u-tepung-sak', tenantId: TID, productId: 'tepung', satuan: 'SAK', isBase: false, factorToBase: 25, aktif: true, sortOrder: 1 },
    ]);
    await move('tepung', 100);

    const res = await call('POST', ['stok', 'penyesuaian'], { reasonCode: 'OPNAME', items: [{ stokId: 'tepung', qtyAktual: 3, uomId: 'u-tepung-sak' }] }, SPV);
    expect(res.status).toBe(200);
    expect(await lokasiQty('tepung')).toBe(75);
    const kartu = await db.collection('stok_kartu').findOne({ tenantId: TID, sourceType: 'PENYESUAIAN', sourceId: String(res.data.id) });
    expect(kartu?.keluar).toBe(25);
    expect(kartu?.qtyEntered).toBe(1);
    expect(kartu?.satuan).toBe('SAK');

    const toZero = await call('POST', ['stok', 'penyesuaian'], { reasonCode: 'OPNAME', items: [{ stokId: 'tepung', qtyAktual: 0, uomId: 'u-tepung-sak' }] }, SPV);
    expect(toZero.status).toBe(200);
    const kartuZero = await db.collection('stok_kartu').findOne({ tenantId: TID, sourceType: 'PENYESUAIAN', sourceId: String(toZero.data.id) });
    expect(kartuZero?.keluar).toBe(75);
    expect(kartuZero?.qtyEntered ?? null).toBeNull();
    expect(kartuZero?.satuan).toBe('KG');
  });
});
