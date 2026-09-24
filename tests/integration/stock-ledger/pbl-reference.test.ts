/**
 * Fase 1.4 — PBL acuan (stockMode REFERENCE): stok hanya keluar lewat RL, PBL mengonfirmasi acuan.
 * Handler PBL/RL/rencana/HPP asli pada Mongo replica set.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import type { HandlerContext } from '@/types/api/handler';

vi.mock('@/lib/api/transaction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/transaction')>('@/lib/api/transaction');
  const testDb = () => (globalThis as { __pblRefDb?: Db }).__pblRefDb!;
  return {
    ...actual,
    runInTransactionOrFallback: (fn: Parameters<typeof actual.runInTransactionOrFallback>[0]) => (
      actual.runInTransactionOnDb(testDb(), fn)
    ),
  };
});

const { handleInventoryReleases } = await import('@/lib/api/handlers/inventory-releases');
const { handleMaterialIssues } = await import('@/lib/api/handlers/material-issues');
const { handleProductionPlans } = await import('@/lib/api/handlers/production-plans');
const { handleFoodCosts } = await import('@/lib/api/handlers/food-costs');
const { aggregatePlanMaterialConsumption } = await import('@/lib/food-production/material-issue-reconcile');
const { traceBatchBackward, traceLotForward } = await import('@/lib/food-production/food-safety-traceability');
const { loadActualConsumption } = await import('@/lib/food-production/actual-consumption');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-14';
const TID_RL_ONLY = 'it-14-rl';
const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

const user = (userId: string, role: string, tenantId = TID): AuthContext => ({
  userId, role, tenantId, name: userId, email: `${userId}@x`, isMaster: false,
} as AuthContext);
const GUDANG = user('u-gudang', 'GUDANG');
const ADMIN = user('u-admin', 'ADMIN');
const SPV = user('u-spv', 'SUPERVISOR');

type Handler = (ctx: HandlerContext) => Promise<Response | null>;

describe.skipIf(!MongoMemoryReplSet)('Fase 1.4 PBL acuan (Mongo replica set)', { timeout: 60_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  async function call(
    handler: Handler,
    auth: AuthContext,
    method: string,
    path: string[],
    body: Record<string, unknown> = {},
    query = '',
  ) {
    const url = new URL(`http://local/api/${path.join('/')}${query}`);
    const res = await handler({
      db,
      route: `/${path.join('/')}`,
      method,
      path,
      body,
      url,
      auth,
      request: new Request(url, { method }),
    } as unknown as HandlerContext);
    expect(res, `${method} /${path.join('/')} tidak ditangani`).toBeTruthy();
    const json = await res!.json() as Record<string, unknown>;
    return { status: res!.status, json };
  }

  const issues = (auth: AuthContext, method: string, path: string[], body: Record<string, unknown> = {}) => (
    call(handleMaterialIssues as Handler, auth, method, ['material-issues', ...path], body)
  );

  async function postedRl(planId: string, qty: number, tenantId = TID) {
    const gudang = user('u-gudang', 'GUDANG', tenantId);
    const spv = user('u-spv', 'SUPERVISOR', tenantId);
    const created = await call(handleInventoryReleases as Handler, gudang, 'POST', ['inventory-releases'], {
      lokasiKode: 'GKERING',
      keperluan: 'Masak menu produksi',
      productionPlanId: planId,
      items: [{ stokId: 'gula', qty, satuan: 'KG' }],
      submit: true,
    });
    expect(created.status).toBe(200);
    const approved = await call(handleInventoryReleases as Handler, spv, 'POST', ['inventory-releases', String(created.json.id), 'approve']);
    expect(approved.status).toBe(200);
    return String(created.json.id);
  }

  async function seedPlan(id: string, acuanKg: number, tenantId = TID) {
    await db.collection('production_plans').insertOne({
      id, tenantId, noDokumen: id.toUpperCase(), status: 'APPROVED', tanggal: TODAY, kitchenId: 'k1',
      kitchenWarehouseKode: 'GKERING', lines: [{ recipeId: 'rcp-gula', targetPorsi: 1 }],
    });
    await db.collection('material_requirements').insertOne({
      id: `mrp-${id}`, tenantId, noDokumen: `MRP-${id}`, productionPlanId: id, status: 'APPROVED', createdAt: new Date(),
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
    db = client.db('pbl_reference_it');
    (globalThis as { __pblRefDb?: Db }).__pblRefDb = db;

    for (const tenantId of [TID, TID_RL_ONLY]) {
      await db.collection('tenant_settings').insertOne({
        tenantId,
        features: {
          rlFromPoReference: true,
          pblReferenceMode: tenantId === TID,
          foodSafetyHoldEnabled: false,
        },
      });
      await db.collection('products').insertOne({
        id: 'gula', tenantId, kode: 'GL01', nama: 'Gula', satuan: 'KG', aktif: true, gudangKode: 'GKERING', hargaBeli: 10,
      });
      await db.collection('product_uom').insertOne({
        id: `gula-KG-${tenantId}`, tenantId, productId: 'gula', satuan: 'KG', factorToBase: 1, isBase: true, aktif: true, sortOrder: 0,
      });
      await db.collection('stok_lokasi').insertOne({ id: `gula-${tenantId}`, tenantId, stokId: 'gula', lokasiKode: 'GKERING', qty: 1000 });
      await db.collection('stok_kartu').insertOne({ id: `seed-${tenantId}`, tenantId, stokId: 'gula', lokasiKode: 'GKERING', masuk: 1000, keluar: 0 });
      await db.collection('recipes').insertOne({
        id: 'rcp-gula', tenantId, kode: 'RCP-GULA', nama: 'Resep gula', yieldQty: 1, aktif: true,
        lines: [{ productId: 'gula', qty: 1, qtyBesar: 1, pctKecil: 100, qtyKecil: 1, satuan: 'KG' }],
      });
    }
    await db.collection('ingredient_lots').insertOne({
      id: 'lot-gula-1', tenantId: TID, lotNo: 'LOT-GULA-1', productId: 'gula', productNama: 'Gula', warehouseKode: 'GKERING',
      qty: 1000, qtyRemaining: 1000, status: 'ACTIVE', expiryDate: '2099-12-31', supplierId: 'sup-1', noGRN: 'GRN-1',
    });
    await seedPlan('plan-r', 5);
    await seedPlan('plan-s', 2);
    await seedPlan('plan-legacy', 5, TID_RL_ONLY);
  }, 240_000);

  afterAll(async () => {
    delete (globalThis as { __pblRefDb?: Db }).__pblRefDb;
    await client?.close();
    await rs?.stop();
  });

  let issueId = '';
  let rlId = '';

  it('buat PBL: baris dari acuan PO (qty keluar 0), baris manual & edit qty ditolak', async () => {
    const manual = await issues(ADMIN, 'POST', [], { productionPlanId: 'plan-r', lines: [{ productId: 'gula', qtyIssued: 5 }] });
    expect(manual.status).toBe(400);
    expect(String(manual.json.error)).toMatch(/PBL acuan/);

    const created = await issues(ADMIN, 'POST', [], { productionPlanId: 'plan-r' });
    expect(created.status).toBe(200);
    issueId = String(created.json.id);
    expect(created.json).toMatchObject({ stockMode: 'REFERENCE', materialRequirementId: 'mrp-plan-r' });
    const lines = created.json.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      productId: 'gula', sumber: 'PO', acuanQty: 5, poQtyReceived: 5, qtyPlanned: 5, qtyIssued: 0, rlPosted: 0, sisa: 5,
      warehouseKode: 'GKERING',
    });

    const put = await issues(ADMIN, 'PUT', [issueId], { lines: [{ productId: 'gula', qtyIssued: 5 }] });
    expect(put.status).toBe(400);
    const note = await issues(ADMIN, 'PUT', [issueId], { catatan: 'Menu utama' });
    expect(note.status).toBe(200);
    expect(note.json.catatan).toBe('Menu utama');
  });

  it('RL tertaut rencana menurunkan sisa; Perbarui acuan & rekonsiliasi memakai data live', async () => {
    rlId = await postedRl('plan-r', 3);

    const rec = await issues(ADMIN, 'GET', [issueId, 'reconciliation']);
    expect(rec.status).toBe(200);
    expect(rec.json).toMatchObject({ mode: 'REFERENCE', lines: [] });
    expect(rec.json.summary).toMatchObject({ qtyAlreadyIssuedTotal: 3, qtyRemainingTotal: 2, mismatchCount: 0, sisaLineCount: 1 });

    const refreshed = await issues(ADMIN, 'POST', [issueId, 'reconcile'], {});
    expect(refreshed.status).toBe(200);
    expect((refreshed.json.lines as Array<Record<string, unknown>>)[0]).toMatchObject({ rlPosted: 3, sisa: 2, qtyIssued: 0 });
    expect(refreshed.json.summary).toMatchObject({ rlPostedTotal: 3, sisaTotal: 2, sisaLineCount: 1 });
  });

  it('selesai dengan sisa wajib catatan; tidak ada mutasi stok dari PBL', async () => {
    expect((await issues(ADMIN, 'POST', [issueId, 'status'], { status: 'SUBMITTED' })).status).toBe(200);
    expect((await issues(ADMIN, 'POST', [issueId, 'status'], { status: 'APPROVED' })).status).toBe(200);

    const kartuBefore = await db.collection('stok_kartu').countDocuments({ tenantId: TID });
    const tanpa = await issues(ADMIN, 'POST', [issueId, 'status'], { status: 'COMPLETED' });
    expect(tanpa.status).toBe(400);
    expect(String(tanpa.json.error)).toMatch(/1 bahan belum keluar penuh lewat RL \(Gula sisa 2 KG\)/);
    expect(String(tanpa.json.error)).toMatch(/catatan konfirmasi/);

    const done = await issues(ADMIN, 'POST', [issueId, 'status'], { status: 'COMPLETED', note: 'Sisa gula tidak dipakai' });
    expect(done.status).toBe(200);
    expect(done.json.status).toBe('COMPLETED');
    expect(done.json.stockPostedAt).toBeUndefined();
    expect(done.json.completionAck).toMatchObject({ reason: 'Sisa gula tidak dipakai', sisaLineCount: 1, pendingRlCount: 0 });

    expect(await db.collection('stok_kartu').countDocuments({ tenantId: TID })).toBe(kartuBefore);
    expect(await db.collection('stok_kartu').countDocuments({ tenantId: TID, sourceType: 'FP_ISSUE' })).toBe(0);
    expect((await db.collection('stok_lokasi').findOne({ tenantId: TID, stokId: 'gula' }))?.qty).toBe(997);

    const audit = await db.collection('audit_log').findOne({ entityId: issueId, action: 'ISSUE_COMPLETE' });
    expect(audit?.metadata).toMatchObject({ stockMode: 'REFERENCE', sisaLineCount: 1, pendingRlCount: 0 });

    const del = await issues(ADMIN, 'DELETE', [issueId]);
    expect(del.status).toBe(400);
    expect(String(del.json.error)).toMatch(/PBL acuan yang sudah selesai/);
  });

  it('konsumsi rencana = RL saja; kesiapan & HPP aktual dari kartu RL', async () => {
    const consumption = await aggregatePlanMaterialConsumption(db, { tenantId: TID } as AuthContext, 'plan-r');
    expect(consumption.get('gula')).toMatchObject({ operational: 3, pbl: 0, total: 3 });

    const ready = await call(handleProductionPlans as unknown as Handler, ADMIN, 'GET', ['production-plans', 'plan-r', 'material-readiness']);
    expect(ready.status).toBe(200);
    expect(ready.json).toMatchObject({
      pblReferenceMode: true, issueCompleted: true, materialsReady: true, rlFulfilled: false, sisaLineCount: 1,
    });

    const cost = await call(handleFoodCosts as Handler, ADMIN, 'GET', ['food-costs', 'analyze'], {}, '?scope=actual&id=plan-r');
    expect(cost.status).toBe(200);
    const actualLines = cost.json.actualLines as Array<Record<string, unknown>>;
    expect(actualLines).toHaveLength(1);
    expect(actualLines[0]).toMatchObject({ productId: 'gula', qty: 3, amount: 30, costSource: 'KARTU' });
  });

  it('HPP: kartu RL lama tanpa sourceId dicocokkan lewat nomor RL', async () => {
    await seedPlan('plan-old', 5);
    await db.collection('inventory_releases').insertOne({
      id: 'rl-old', tenantId: TID, noRelease: 'RL-OLD-1', status: 'POSTED', keperluan: 'Masak menu', lokasiKode: 'GKERING',
      productionPlanId: 'plan-old', items: [{ stokId: 'gula', qty: 2, qtyBase: 2, satuan: 'KG' }],
    });
    await db.collection('stok_kartu').insertOne({
      id: 'kartu-old', tenantId: TID, stokId: 'gula', lokasiKode: 'GKERING', sourceType: 'RELEASE', noTransaksi: 'RL-OLD-1',
      masuk: 0, keluar: 2, hargaSatuan: 12,
    });
    const cost = await call(handleFoodCosts as Handler, ADMIN, 'GET', ['food-costs', 'analyze'], {}, '?scope=actual&id=plan-old');
    expect(cost.status).toBe(200);
    expect((cost.json.actualLines as Array<Record<string, unknown>>)[0]).toMatchObject({ qty: 2, amount: 24, costSource: 'KARTU' });
    await db.collection('inventory_releases').deleteOne({ id: 'rl-old' });
    await db.collection('stok_kartu').deleteOne({ id: 'kartu-old' });
    await db.collection('production_plans').deleteOne({ id: 'plan-old' });
  });

  it('traceability batch ↔ lot lewat alokasi lot RL', async () => {
    const rl = await db.collection('inventory_releases').findOne({ id: rlId });
    expect(rl?.ingredientLotConsume?.[0]?.allocations?.[0]).toMatchObject({ batchId: 'lot-gula-1', qty: 3 });
    await db.collection('production_batches').insertOne({
      id: 'batch-r', tenantId: TID, batchNo: 'B-R', productionPlanId: 'plan-r', finishedGoodNama: 'Nasi', foodSafetyStatus: 'PASS',
    });

    const back = await traceBatchBackward(db, { tenantId: TID, productionBatchId: 'batch-r' });
    expect('error' in back).toBe(false);
    if ('error' in back) return;
    expect(back.candidateLots).toHaveLength(1);
    expect(back.candidateLots[0]).toMatchObject({
      lotId: 'lot-gula-1', allocatedQty: 3, releaseId: rlId, supplierId: 'sup-1', noGRN: 'GRN-1',
    });

    const fwd = await traceLotForward(db, { tenantId: TID, ingredientLotId: 'lot-gula-1' });
    expect('error' in fwd).toBe(false);
    if ('error' in fwd) return;
    expect(fwd.candidateBatches.map((b) => b.batchId)).toEqual(['batch-r']);
    expect(fwd.candidateLots[0].allocatedQty).toBe(3);
  });

  it('forecast/rekomendasi: titik konsumsi dari RL (hari masak rencana), waste acuan vs RL', async () => {
    const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const out = await loadActualConsumption(db, { tenantId: TID } as AuthContext, { tenantId: TID, sinceIso: since, issueLimit: 100 });
    expect(out.referenceMode).toBe(true);
    const gulaPoints = out.points.filter((p) => p.productId === 'gula');
    expect(gulaPoints.reduce((s, p) => s + p.qty, 0)).toBe(3);
    expect(out.wasteLines.find((l) => l.productId === 'gula')).toMatchObject({ qtyPlanned: 5, qtyIssued: 3 });
  });

  it('RL tertunda tanpa sisa tetap wajib catatan; RL memenuhi acuan membuka kesiapan', async () => {
    await postedRl('plan-s', 2);
    const created = await issues(ADMIN, 'POST', [], { productionPlanId: 'plan-s' });
    expect(created.status).toBe(200);
    const id = String(created.json.id);

    const ready = await call(handleProductionPlans as unknown as Handler, ADMIN, 'GET', ['production-plans', 'plan-s', 'material-readiness']);
    expect(ready.json).toMatchObject({ materialsReady: true, rlFulfilled: true, sisaLineCount: 0, issueCompleted: false });

    const pending = await call(handleInventoryReleases as Handler, GUDANG, 'POST', ['inventory-releases'], {
      lokasiKode: 'GKERING', keperluan: 'Masak menu produksi', productionPlanId: 'plan-s',
      items: [{ stokId: 'gula', qty: 1, satuan: 'KG', overReason: 'Tambah porsi tamu' }],
      submit: true,
    });
    expect(pending.status).toBe(200);
    expect(pending.json.status).toBe('PENDING_APPROVAL');

    await issues(ADMIN, 'POST', [id, 'status'], { status: 'SUBMITTED' });
    await issues(ADMIN, 'POST', [id, 'status'], { status: 'APPROVED' });
    const tanpa = await issues(ADMIN, 'POST', [id, 'status'], { status: 'COMPLETED' });
    expect(tanpa.status).toBe(400);
    expect(String(tanpa.json.error)).toMatch(/1 RL belum diposting/);

    await db.collection('inventory_releases').updateOne({ id: pending.json.id }, { $set: { status: 'REJECTED' } });
    await db.collection('inventory_releases').insertOne({
      id: 'rl-draft-s', tenantId: TID, noRelease: 'RL-DRAFT-S', status: 'DRAFT', lokasiKode: 'GKERING',
      productionPlanId: 'plan-s', items: [{ stokId: 'gula', qty: 1, qtyBase: 1, satuan: 'KG' }],
    });
    const draft = await issues(ADMIN, 'POST', [id, 'status'], { status: 'COMPLETED' });
    expect(draft.status).toBe(400);
    expect(String(draft.json.error)).toMatch(/1 RL belum diposting \(draft\/menunggu persetujuan\)/);
    await db.collection('inventory_releases').deleteOne({ id: 'rl-draft-s' });

    const ok = await issues(ADMIN, 'POST', [id, 'status'], { status: 'COMPLETED' });
    expect(ok.status).toBe(200);
    expect(ok.json.completionAck).toBeUndefined();
    expect(await db.collection('stok_kartu').countDocuments({ tenantId: TID, sourceType: 'FP_ISSUE' })).toBe(0);
  });

  it('flag dimatikan setelah PBL acuan selesai: konsumsi & HPP rencana tersebut tetap dari RL', async () => {
    await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { 'features.pblReferenceMode': false } });
    try {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      const out = await loadActualConsumption(db, { tenantId: TID } as AuthContext, { tenantId: TID, sinceIso: since, issueLimit: 100 });
      expect(out.referenceMode).toBe(false);
      const gulaQty = out.points.filter((p) => p.productId === 'gula').reduce((s, p) => s + p.qty, 0);
      expect(gulaQty).toBe(5);

      const cost = await call(handleFoodCosts as Handler, ADMIN, 'GET', ['food-costs', 'analyze'], {}, '?scope=actual&id=plan-r');
      expect(cost.status).toBe(200);
      expect((cost.json.actualLines as Array<Record<string, unknown>>)[0]).toMatchObject({ qty: 3, amount: 30, costSource: 'KARTU' });
    } finally {
      await db.collection('tenant_settings').updateOne({ tenantId: TID }, { $set: { 'features.pblReferenceMode': true } });
    }
  });

  it('tenant hanya rlFromPoReference: PBL tetap mode stok lama', async () => {
    const admin = user('u-admin', 'ADMIN', TID_RL_ONLY);
    const created = await call(handleMaterialIssues as Handler, admin, 'POST', ['material-issues'], { productionPlanId: 'plan-legacy' });
    expect(created.status).toBe(200);
    expect(created.json.stockMode).toBeUndefined();
    expect((created.json.lines as Array<Record<string, unknown>>)[0].qtyIssued).toBeGreaterThan(0);

    const ready = await call(handleProductionPlans as unknown as Handler, admin, 'GET', ['production-plans', 'plan-legacy', 'material-readiness']);
    expect(ready.json.pblReferenceMode).toBe(false);
  });
});
