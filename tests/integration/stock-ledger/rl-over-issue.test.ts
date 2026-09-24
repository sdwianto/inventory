/**
 * Fase 1.3 — kontrol RL melebihi acuan, validasi ulang tautan saat approve, dan worklist
 * "RL belum tertaut", lewat handler RL asli pada Mongo replica set.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import type { HandlerContext } from '@/types/api/handler';

vi.mock('@/lib/api/transaction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/transaction')>('@/lib/api/transaction');
  const testDb = () => (globalThis as { __rlOverIssueDb?: Db }).__rlOverIssueDb!;
  return {
    ...actual,
    runInTransactionOrFallback: (fn: Parameters<typeof actual.runInTransactionOrFallback>[0]) => (
      actual.runInTransactionOnDb(testDb(), fn)
    ),
  };
});

const { handleInventoryReleases } = await import('@/lib/api/handlers/inventory-releases');
const { aggregatePlanMaterialConsumption } = await import('@/lib/food-production/material-issue-reconcile');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-13';
const TID_OFF = 'it-13-off';
const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

const user = (userId: string, role: string, tenantId = TID): AuthContext => ({
  userId, role, tenantId, name: userId, email: `${userId}@x`, isMaster: false,
} as AuthContext);
const GUDANG = user('u-gudang', 'GUDANG');
const ADMIN = user('u-admin', 'ADMIN');
const SPV = user('u-spv', 'SUPERVISOR');
const SPV2 = user('u-spv2', 'SUPERVISOR');

describe.skipIf(!MongoMemoryReplSet)('Fase 1.3 RL vs acuan rencana (Mongo replica set)', { timeout: 60_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  async function call(auth: AuthContext, method: string, path: string[], body: Record<string, unknown> = {}, query = '') {
    const url = new URL(`http://local/api/${path.join('/')}${query}`);
    const res = await handleInventoryReleases({
      db,
      route: `/${path.join('/')}`,
      method,
      path,
      body,
      url,
      auth,
      request: new Request(url, { method }),
    } as unknown as HandlerContext);
    const json = await res!.json() as Record<string, unknown>;
    return { status: res!.status, json };
  }

  async function createRl(auth: AuthContext, planId: string | undefined, qty: number, extra: Record<string, unknown> = {}) {
    return call(auth, 'POST', ['inventory-releases'], {
      lokasiKode: 'GKERING',
      keperluan: 'Masak menu produksi',
      ...(planId ? { productionPlanId: planId } : {}),
      items: [{ stokId: 'gula', qty, satuan: 'KG', ...extra }],
      submit: true,
    });
  }

  async function seedPlan(id: string, acuanKg: number, status = 'APPROVED', tenantId = TID, kitchenId = 'k1') {
    await db.collection('production_plans').insertOne({
      id, tenantId, noDokumen: id.toUpperCase(), status, tanggal: TODAY, kitchenId, lines: [],
    });
    await db.collection('material_requirements').insertOne({
      id: `mrp-${id}`, tenantId, productionPlanId: id, status: 'APPROVED', createdAt: new Date(),
      lines: [{ productId: 'gula', productNama: 'Gula', satuan: 'KG', qtyGross: acuanKg }],
    });
    await db.collection('customer_purchase_orders').insertOne({
      id: `po-${id}`, tenantId, noPO: `CPO-${id}`, productionPlanId: id, status: 'RECEIVED', createdAt: new Date(),
      items: [{ localStokId: 'gula', kode: 'GL01', satuan: 'KG', qty: acuanKg, qtyReceived: acuanKg }],
    });
  }

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('rl_over_issue_it');
    (globalThis as { __rlOverIssueDb?: Db }).__rlOverIssueDb = db;

    for (const tenantId of [TID, TID_OFF]) {
      await db.collection('tenant_settings').insertOne({
        tenantId,
        features: { rlFromPoReference: tenantId === TID, foodSafetyHoldEnabled: false },
      });
      await db.collection('products').insertOne({
        id: 'gula', tenantId, kode: 'GL01', nama: 'Gula', satuan: 'KG', aktif: true, gudangKode: 'GKERING', hargaBeli: 10,
      });
      await db.collection('product_uom').insertOne({
        id: `gula-KG-${tenantId}`, tenantId, productId: 'gula', satuan: 'KG', factorToBase: 1, isBase: true, aktif: true, sortOrder: 0,
      });
      await db.collection('stok_lokasi').insertOne({ id: `gula-${tenantId}`, tenantId, stokId: 'gula', lokasiKode: 'GKERING', qty: 1000 });
      await db.collection('stok_kartu').insertOne({ id: `seed-${tenantId}`, tenantId, stokId: 'gula', lokasiKode: 'GKERING', masuk: 1000, keluar: 0 });
    }
    await db.collection('products').insertOne({
      id: 'gula-b', tenantId: TID, kode: 'GL01', nama: 'Gula', satuan: 'KG', aktif: true, gudangKode: 'GKERING', hargaBeli: 10,
    });
    await db.collection('product_uom').insertOne({
      id: 'gula-b-KG', tenantId: TID, productId: 'gula-b', satuan: 'KG', factorToBase: 1, isBase: true, aktif: true, sortOrder: 0,
    });
    await db.collection('stok_lokasi').insertOne({ id: 'gula-b-it', tenantId: TID, stokId: 'gula-b', lokasiKode: 'GKERING', qty: 1000 });
    await db.collection('stok_kartu').insertOne({ id: 'seed-gula-b', tenantId: TID, stokId: 'gula-b', lokasiKode: 'GKERING', masuk: 1000, keluar: 0 });
    await db.collection('products').insertOne({
      id: 'gula-gr', tenantId: TID, kode: 'GL01', nama: 'Gula (gram)', satuan: 'GRAM', aktif: true, gudangKode: 'GKERING', hargaBeli: 1,
    });
    await db.collection('product_uom').insertOne({
      id: 'gula-gr-GRAM', tenantId: TID, productId: 'gula-gr', satuan: 'GRAM', factorToBase: 1, isBase: true, aktif: true, sortOrder: 0,
    });
    await db.collection('stok_lokasi').insertOne({ id: 'gula-gr-it', tenantId: TID, stokId: 'gula-gr', lokasiKode: 'GKERING', qty: 5000 });
    await seedPlan('plan-a', 5);
    await seedPlan('plan-b', 5);
    await seedPlan('plan-c', 5);
    await seedPlan('plan-off', 5, 'APPROVED', TID_OFF);
  }, 240_000);

  afterAll(async () => {
    delete (globalThis as { __rlOverIssueDb?: Db }).__rlOverIssueDb;
    await client?.close();
    await rs?.stop();
  });

  it('ajukan melebihi acuan tanpa alasan ditolak; dengan alasan tersimpan beserta snapshot', async () => {
    const tanpa = await createRl(GUDANG, 'plan-a', 6);
    expect(tanpa.status).toBe(400);
    expect(String(tanpa.json.error)).toMatch(/Melebihi acuan rencana \(toleransi 0%\)/);
    expect(String(tanpa.json.error)).toMatch(/total 6 KG > batas 5 KG/);

    const dengan = await createRl(GUDANG, 'plan-a', 6, { overReason: 'Porsi tambahan tamu' });
    expect(dengan.status).toBe(200);
    expect(dengan.json.status).toBe('PENDING_APPROVAL');
    const snap = dengan.json.overIssue as { lines: Array<Record<string, unknown>> };
    expect(snap.lines).toHaveLength(1);
    expect(snap.lines[0]).toMatchObject({ acuanQty: 5, qtyAfter: 6, limitQty: 5, overQty: 1, reasons: ['Porsi tambahan tamu'] });
  });

  it('RL melebihi acuan: pembuat (ADMIN) tidak bisa menyetujui sendiri, supervisor lain bisa', async () => {
    const created = await createRl(ADMIN, 'plan-b', 7, { overReason: 'Resep direvisi' });
    expect(created.status).toBe(200);
    const id = String(created.json.id);

    const self = await call(ADMIN, 'POST', ['inventory-releases', id, 'approve']);
    expect(self.status).toBe(403);
    expect(String(self.json.error)).toMatch(/pengguna lain/);
    expect((await db.collection('inventory_releases').findOne({ id }))?.status).toBe('PENDING_APPROVAL');

    const other = await call(SPV, 'POST', ['inventory-releases', id, 'approve']);
    expect(other.status).toBe(200);
    const doc = await db.collection('inventory_releases').findOne({ id });
    expect(doc?.status).toBe('POSTED');
    expect(doc?.overIssue?.lines?.[0]).toMatchObject({ consumedBefore: 0, qtyAfter: 7, reasons: ['Resep direvisi'] });
    const audit = await db.collection('audit_log').findOne({ entityId: id, action: 'INVENTORY_RELEASE' });
    expect(audit?.summary).toMatch(/melebihi acuan 1 produk/);
    expect(audit?.metadata?.productionPlanId).toBe('plan-b');
  });

  it('RL dalam acuan: ADMIN tetap boleh menyetujui sendiri (perilaku lama)', async () => {
    await seedPlan('plan-d', 5);
    const created = await createRl(ADMIN, 'plan-d', 2);
    const res = await call(ADMIN, 'POST', ['inventory-releases', String(created.json.id), 'approve']);
    expect(res.status).toBe(200);
    expect((await db.collection('inventory_releases').findOne({ id: created.json.id }))?.overIssue).toBeUndefined();
  });

  it('dua approve bersamaan untuk rencana yang sama dihitung berurutan: yang kedua kena kontrol', async () => {
    const a = await createRl(GUDANG, 'plan-c', 3);
    const b = await createRl(GUDANG, 'plan-c', 3);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [ra, rb] = await Promise.all([
      call(SPV, 'POST', ['inventory-releases', String(a.json.id), 'approve']),
      call(SPV2, 'POST', ['inventory-releases', String(b.json.id), 'approve']),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 400]);
    const failed = ra.status === 400 ? ra : rb;
    expect(String(failed.json.error)).toMatch(/total 6 KG > batas 5 KG/);
    const posted = await db.collection('inventory_releases')
      .find({ tenantId: TID, productionPlanId: 'plan-c', status: 'POSTED' }).toArray();
    expect(posted).toHaveLength(1);
    const kartuOut = await db.collection('stok_kartu')
      .find({ tenantId: TID, sourceType: 'RELEASE', sourceId: { $in: [a.json.id, b.json.id] } }).toArray();
    expect(kartuOut).toHaveLength(1);
  });

  it('salinan katalog satu kode dihitung satu acuan; approve bersamaan tetap berurutan lewat kunci rencana', async () => {
    await seedPlan('plan-f', 5);
    const a = await createRl(GUDANG, 'plan-f', 3);
    const b = await call(GUDANG, 'POST', ['inventory-releases'], {
      lokasiKode: 'GKERING',
      keperluan: 'Masak menu produksi',
      productionPlanId: 'plan-f',
      items: [{ stokId: 'gula-b', qty: 3, satuan: 'KG' }],
      submit: true,
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [ra, rb] = await Promise.all([
      call(SPV, 'POST', ['inventory-releases', String(a.json.id), 'approve']),
      call(SPV2, 'POST', ['inventory-releases', String(b.json.id), 'approve']),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 400]);
    const posted = await db.collection('inventory_releases')
      .countDocuments({ tenantId: TID, productionPlanId: 'plan-f', status: 'POSTED' });
    expect(posted).toBe(1);
  });

  it('ADMIN yang menyunting & mengajukan RL orang lain yang melebihi acuan tidak bisa menyetujuinya', async () => {
    await seedPlan('plan-g', 5);
    const draft = await call(GUDANG, 'POST', ['inventory-releases'], {
      lokasiKode: 'GKERING', keperluan: 'Masak menu produksi', productionPlanId: 'plan-g',
      items: [{ stokId: 'gula', qty: 2, satuan: 'KG' }],
    });
    expect(draft.json.status).toBe('DRAFT');
    const id = String(draft.json.id);
    const edited = await call(ADMIN, 'PATCH', ['inventory-releases', id], {
      lokasiKode: 'GKERING', keperluan: 'Masak menu produksi', productionPlanId: 'plan-g',
      items: [{ stokId: 'gula', qty: 8, satuan: 'KG', overReason: 'Tambah porsi' }],
      submit: true,
    });
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({ status: 'PENDING_APPROVAL', submittedBy: { userId: ADMIN.userId }, lastEditedBy: { userId: ADMIN.userId } });

    const self = await call(ADMIN, 'POST', ['inventory-releases', id, 'approve']);
    expect(self.status).toBe(403);
    const other = await call(SPV, 'POST', ['inventory-releases', id, 'approve']);
    expect(other.status).toBe(200);
  });

  it('salinan katalog kode sama tapi satuan dasar beda tidak digabung ke acuan (di luar acuan)', async () => {
    await seedPlan('plan-h', 5);
    const preview = (stokId: string, qty: number, satuan: string) => call(GUDANG, 'POST', ['inventory-releases', 'over-issue-preview'], {
      lokasiKode: 'GKERING', productionPlanId: 'plan-h', items: [{ stokId, qty, satuan }],
    });
    const sameUnit = await preview('gula-b', 3, 'KG');
    expect(sameUnit.status).toBe(200);
    expect(sameUnit.json).toMatchObject({ enabled: true, overCount: 0 });

    const gram = await preview('gula-gr', 100, 'GRAM');
    expect(gram.status).toBe(200);
    const lines = gram.json.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ productId: 'gula-gr', sumber: 'DI_LUAR_ACUAN', acuanQty: 0, qtyAfter: 100 });
  });

  it('tautan manual ke rencana dapur lain ditolak', async () => {
    await seedPlan('plan-k2', 5, 'APPROVED', TID, 'k2');
    await db.collection('inventory_releases').insertOne({
      id: 'rl-k1', tenantId: TID, noRelease: 'RL-K1', status: 'POSTED', keperluan: 'Masak menu', lokasiKode: 'GKERING',
      kitchenId: 'k1', tanggal: new Date(`${TODAY}T08:00:00+07:00`), createdBy: { userId: GUDANG.userId },
      items: [{ stokId: 'gula', qty: 1, qtyBase: 1, satuan: 'KG' }],
    });
    const res = await call(SPV, 'POST', ['inventory-releases', 'rl-k1', 'link-plan'], {
      productionPlanId: 'plan-k2', reason: 'Salah dapur',
    });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/dapur lain/);
    expect((await db.collection('inventory_releases').findOne({ id: 'rl-k1' }))?.productionPlanId).toBeUndefined();
    await db.collection('inventory_releases').updateOne({ id: 'rl-k1' }, { $set: { planLinkDismissedAt: new Date() } });
  });

  it('tautan rencana divalidasi ulang saat approve', async () => {
    await seedPlan('plan-e', 5);
    const created = await createRl(GUDANG, 'plan-e', 1);
    await db.collection('production_plans').updateOne({ id: 'plan-e' }, { $set: { status: 'COMPLETED' } });
    const res = await call(SPV, 'POST', ['inventory-releases', String(created.json.id), 'approve']);
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/tidak berstatus Disetujui\/Diproses/);
    expect((await db.collection('inventory_releases').findOne({ id: created.json.id }))?.status).toBe('PENDING_APPROVAL');
  });

  it('RL tanpa tautan: tidak dihitung ke rencana, muncul di worklist, ditautkan manual dengan audit', async () => {
    const orphan = (id: string, createdBy: AuthContext, qty: number, keperluan = 'Masak menu') => ({
      id, tenantId: TID, noRelease: id.toUpperCase(), status: 'POSTED', keperluan, lokasiKode: 'GKERING',
      tanggal: new Date(`${TODAY}T08:00:00+07:00`),
      createdBy: { userId: createdBy.userId, userName: createdBy.name },
      items: [{ stokId: 'gula', kode: 'GL01', nama: 'Gula', qty, qtyBase: qty, satuan: 'KG' }],
    });
    await db.collection('inventory_releases').insertMany([
      orphan('rl-orphan-1', GUDANG, 1),
      orphan('rl-orphan-2', SPV, 9),
      orphan('rl-orphan-3', GUDANG, 1, 'Sampel lab'),
      orphan('rl-cuci', GUDANG, 1, 'Cuci peralatan'),
    ]);

    const before = await aggregatePlanMaterialConsumption(db, { tenantId: TID } as AuthContext, 'plan-a', {
      includeOrphanOperational: true,
      planMeta: { tenantId: TID, tanggal: TODAY, kitchenId: 'k1' },
    });
    expect(before.get('gula')?.operational ?? 0).toBe(0);

    const list = await call(SPV, 'GET', ['inventory-releases', 'unlinked']);
    expect(list.status).toBe(200);
    const rows = list.json.rows as Array<{ id: string; candidates: Array<{ productionPlanId: string }> }>;
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['rl-orphan-1', 'rl-orphan-2', 'rl-orphan-3']);
    expect(rows.find((r) => r.id === 'rl-orphan-1')!.candidates.map((c) => c.productionPlanId)).toContain('plan-d');

    const tanpaAlasan = await call(SPV, 'POST', ['inventory-releases', 'rl-orphan-1', 'link-plan'], { productionPlanId: 'plan-d' });
    expect(tanpaAlasan.status).toBe(400);

    const linked = await call(SPV, 'POST', ['inventory-releases', 'rl-orphan-1', 'link-plan'], {
      productionPlanId: 'plan-d', reason: 'Lupa pilih rencana saat buat RL',
    });
    expect(linked.status).toBe(200);
    expect(linked.json).toMatchObject({ productionPlanId: 'plan-d', planLink: { source: 'MANUAL' } });
    expect(linked.json.overIssue).toBeUndefined();
    const audit = await db.collection('audit_log').findOne({ entityId: 'rl-orphan-1', action: 'INVENTORY_RELEASE_LINK_PLAN' });
    expect(audit?.metadata?.reason).toBe('Lupa pilih rencana saat buat RL');

    const again = await call(SPV2, 'POST', ['inventory-releases', 'rl-orphan-1', 'link-plan'], {
      productionPlanId: 'plan-a', reason: 'Coba tautkan ulang',
    });
    expect(again.status).toBe(400);

    const selfOver = await call(SPV, 'POST', ['inventory-releases', 'rl-orphan-2', 'link-plan'], {
      productionPlanId: 'plan-d', reason: 'Bahan masak tambahan',
    });
    expect(selfOver.status).toBe(403);
    const otherOver = await call(SPV2, 'POST', ['inventory-releases', 'rl-orphan-2', 'link-plan'], {
      productionPlanId: 'plan-d', reason: 'Bahan masak tambahan',
    });
    expect(otherOver.status).toBe(200);
    expect((otherOver.json.overIssue as { lines: unknown[] }).lines).toHaveLength(1);

    const dismissed = await call(SPV, 'POST', ['inventory-releases', 'rl-orphan-3', 'dismiss-link'], { reason: 'Sampel ke lab dinas' });
    expect(dismissed.status).toBe(200);
    const after = await call(SPV, 'GET', ['inventory-releases', 'unlinked']);
    expect((after.json.rows as unknown[]).length).toBe(0);

    const gudangDenied = await call(GUDANG, 'GET', ['inventory-releases', 'unlinked']);
    expect(gudangDenied.status).toBe(403);
  });

  it('tenant tanpa flag: perilaku lama (tanpa kontrol, atribusi RL tanpa tautan tetap jalan)', async () => {
    const gudangOff = user('u-gudang-off', 'GUDANG', TID_OFF);
    const spvOff = user('u-spv-off', 'SUPERVISOR', TID_OFF);
    const created = await createRl(gudangOff, 'plan-off', 9);
    expect(created.status).toBe(200);
    expect(created.json.overIssue).toBeUndefined();
    const approved = await call(spvOff, 'POST', ['inventory-releases', String(created.json.id), 'approve']);
    expect(approved.status).toBe(200);

    await db.collection('inventory_releases').insertOne({
      id: 'rl-off-orphan', tenantId: TID_OFF, noRelease: 'RL-OFF-ORPHAN', status: 'POSTED', keperluan: 'Masak menu',
      tanggal: new Date(`${TODAY}T08:00:00+07:00`), items: [{ stokId: 'gula', qty: 2, qtyBase: 2 }],
    });
    await db.collection('inventory_releases').insertOne({
      id: 'rl-off-dismissed', tenantId: TID_OFF, noRelease: 'RL-OFF-DISMISSED', status: 'POSTED', keperluan: 'Masak menu',
      tanggal: new Date(`${TODAY}T09:00:00+07:00`), items: [{ stokId: 'gula', qty: 5, qtyBase: 5 }],
      planLinkDismissedAt: new Date(),
    });
    const consumption = await aggregatePlanMaterialConsumption(db, { tenantId: TID_OFF } as AuthContext, 'plan-off', {
      includeOrphanOperational: true,
      planMeta: { tenantId: TID_OFF, tanggal: TODAY, kitchenId: 'k1' },
    });
    expect(consumption.get('gula')?.operational).toBe(11);

    const list = await call(spvOff, 'GET', ['inventory-releases', 'unlinked']);
    expect(list.status).toBe(403);
  });
});
