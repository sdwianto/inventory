/**
 * Fase 5a — kontrol master & posting: soft delete produk (hanya stok 0, kode bisa dipakai ulang),
 * stok tidak bisa diubah lewat master produk, role transfer, kunci periode tanggal server + tanggal dokumen.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { postStockMovements } from '@/lib/stock-ledger';
import { handleProducts } from '@/lib/api/handlers/products';
import { handleTransfer } from '@/lib/api/handlers/inventory-transfer';
import { assertPeriodNotLocked } from '@/lib/api/period-lock';
import type { AuthContext } from '@/types/auth';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-f5-ctl';

const auth = (userId: string, role: string): AuthContext => ({
  userId, email: `${userId}@x`, name: userId, role, tenantId: TID, tenantName: TID, isMaster: false,
});
const ADMIN = auth('u-admin', 'ADMIN');

describe.skipIf(!MongoMemoryReplSet)('Fase 5a kontrol master & posting', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  const request = (url: URL) => Object.assign(new Request(url), { cookies: { get: () => ({ value: TID }) } });

  const products = async (method: string, path: string[], body: unknown, who: AuthContext = ADMIN) => {
    const url = new URL(`http://x/api/${path.join('/')}`);
    const res = await handleProducts({ db, route: `/${path.join('/')}`, method, path, body, url, auth: who, request: request(url) });
    if (!res) throw new Error('handler tidak menangani route');
    return { status: res.status, data: await res.json() as Record<string, unknown> };
  };

  const insertProduct = (id: string, kode: string) => db.collection('products').insertOne({
    id, tenantId: TID, kode, nama: id, satuan: 'KG', itemRole: 'INGREDIENT', aktif: true,
    syncSource: 'local', gudangKode: 'GKERING', hargaBeli: 1000, stok: 0, mergedInto: null,
  });

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('phase5_controls_it');
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });
    await db.collection('products').createIndex(
      { tenantId: 1, kode: 1 },
      { unique: true, name: 'uniq_products_tenant_kode_active', partialFilterExpression: { aktif: { $in: [true, null] }, mergedInto: null } },
    );
    await insertProduct('p-kosong', 'KSG');
    await insertProduct('p-isi', 'ISI');
    const res = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'GRN', sourceId: 'grn-1', noTransaksi: 'GRN-1', keterangan: 'seed', postingDate: new Date(),
      lines: [{ lineRef: '1', productId: 'p-isi', warehouseKode: 'GKERING', deltaQtyBase: 3, unitCost: 1000 }],
    });
    if (!res.ok) throw new Error(res.error);
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('hapus produk ditolak selama masih ada stok', async () => {
    const res = await products('DELETE', ['products', 'p-isi'], undefined);
    expect(res.status).toBe(400);
    const doc = await db.collection('products').findOne({ id: 'p-isi' });
    expect(doc?.deletedAt).toBeFalsy();
    const bulk = await products('POST', ['products', 'bulk-delete'], { ids: ['p-kosong', 'p-isi'] });
    expect(bulk.status).toBe(400);
    expect((await db.collection('products').findOne({ id: 'p-kosong' }))?.deletedAt).toBeFalsy();
  });

  it('soft delete stok 0: riwayat tetap, kode dilepas dan bisa dipakai produk baru, tidak tampil di daftar', async () => {
    const res = await products('DELETE', ['products', 'p-kosong'], undefined);
    expect(res.status).toBe(200);
    const doc = await db.collection('products').findOne({ id: 'p-kosong' });
    expect(doc).toMatchObject({ aktif: false, kodeAsli: 'KSG' });
    expect(doc?.deletedAt).toBeInstanceOf(Date);
    expect(String(doc?.kode)).not.toBe('KSG');

    await expect(insertProduct('p-baru', 'KSG')).resolves.toBeTruthy();

    const list = await products('GET', ['products'], undefined);
    const rows = (Array.isArray(list.data) ? list.data : (list.data.data || list.data.items || [])) as Array<Record<string, unknown>>;
    expect(rows.some((r) => r.id === 'p-kosong')).toBe(false);

    const audit = await db.collection('audit_log').findOne({ tenantId: TID, action: 'PRODUCT_DELETE' });
    expect(audit).toBeTruthy();

    const edit = await products('PUT', ['products', 'p-kosong'], { nama: 'hidup lagi' });
    expect(edit.status).toBe(400);

    const grn = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'GRN', sourceId: 'grn-deleted', noTransaksi: 'GRN-DEL', keterangan: 'PO lama', postingDate: new Date(),
      lines: [{ lineRef: '1', productId: 'p-kosong', warehouseKode: 'GKERING', deltaQtyBase: 1, unitCost: 1000 }],
    });
    expect(grn.ok).toBe(false);
    if (!grn.ok) expect(grn.error).toMatch(/sudah dihapus/);
  });

  it('master produk tidak bisa mengubah stok; field milik server diabaikan', async () => {
    const stok = await products('PUT', ['products', 'p-isi'], { stok: 99 });
    expect(stok.status).toBe(400);
    const alasan = await products('PUT', ['products', 'p-isi'], { stokAlasan: 'koreksi' });
    expect(alasan.status).toBe(400);

    const ok = await products('PUT', ['products', 'p-isi'], { nama: 'isi baru', avgCost: 1, deletedAt: new Date().toISOString(), mergedInto: 'x' });
    expect(ok.status).toBe(200);
    const doc = await db.collection('products').findOne({ id: 'p-isi' });
    expect(doc?.nama).toBe('isi baru');
    expect(doc?.avgCost).not.toBe(1);
    expect(doc?.deletedAt).toBeFalsy();
    expect(doc?.mergedInto ?? null).toBeNull();
    const lokasi = await db.collection('stok_lokasi').findOne({ tenantId: TID, stokId: 'p-isi', lokasiKode: 'GKERING' });
    expect(Number(lokasi?.qty)).toBe(3);
  });

  it('transfer stok hanya untuk GUDANG / SUPERVISOR / ADMIN / MASTER', async () => {
    const url = new URL('http://x/api/stok/transfer');
    const res = await handleTransfer({
      db, route: '/stok/transfer', method: 'POST', path: ['stok', 'transfer'],
      body: { lokasiAsal: 'GKERING', lokasiTujuan: 'GBASAH', items: [] }, url, auth: auth('u-kasir', 'KASIR'), request: request(url),
    });
    expect(res?.status).toBe(403);
  });

  it('kunci periode: tanggal server atau tanggal dokumen di periode terkunci ditolak', async () => {
    const past = new Date(Date.now() - 30 * 86_400_000);
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { periodLockedUntil: past.toISOString() } }, { upsert: true });
    const backdated = new Date(past.getTime() - 86_400_000).toISOString();
    expect((await assertPeriodNotLocked(db, ADMIN, { tanggal: backdated }))?.status).toBe(423);
    expect((await assertPeriodNotLocked(db, ADMIN, {}, backdated))?.status).toBe(423);
    expect(await assertPeriodNotLocked(db, ADMIN, { tanggal: new Date().toISOString() })).toBeNull();
    expect(await assertPeriodNotLocked(db, ADMIN, {})).toBeNull();
    expect((await assertPeriodNotLocked(db, ADMIN, { tanggal: 'bukan-tanggal' }))?.status).toBe(400);

    const future = new Date(Date.now() + 86_400_000);
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { periodLockedUntil: future.toISOString() } });
    expect((await assertPeriodNotLocked(db, ADMIN, {}))?.status).toBe(423);
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { periodLockedUntil: 'rusak' } });
    expect(await assertPeriodNotLocked(db, ADMIN, {})).toBeNull();
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $unset: { periodLockedUntil: '' } });
  });
});
