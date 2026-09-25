/**
 * Fase 2.2 — versi resep pada Mongo replica set: setiap simpan resep yang mengubah isi membuat revisi,
 * MRP mem-pin revisi, HPP rencana memakai revisi yang dipin (angka historis tetap), migrasi 0002.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import type { HandlerContext } from '@/types/api/handler';

vi.mock('@/lib/api/transaction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/transaction')>('@/lib/api/transaction');
  const testDb = () => (globalThis as { __recipeRevDb?: Db }).__recipeRevDb!;
  return {
    ...actual,
    runInTransactionOrFallback: (fn: Parameters<typeof actual.runInTransactionOrFallback>[0]) => (
      actual.runInTransactionOnDb(testDb(), fn)
    ),
  };
});

const { handleRecipes } = await import('@/lib/api/handlers/recipes');
const { handleFoodCosts } = await import('@/lib/api/handlers/food-costs');
const { regenerateMrpForPlan } = await import('@/lib/api/handlers/material-requirements');
const { ensureRecipeRevisions, updateRecipeWithRevision } = await import('@/lib/api/recipe-revisions');
const { backfillRecipeRevisionsMigration } = await import('@/lib/migrations/0002-backfill-recipe-revisions');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-22';
const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const ADMIN = {
  userId: 'u-admin', role: 'ADMIN', tenantId: TID, name: 'Admin', email: 'a@x', isMaster: false,
} as AuthContext;

type Handler = (ctx: HandlerContext) => Promise<Response | null>;
type Json = Record<string, unknown>;

describe.skipIf(!MongoMemoryReplSet)('Fase 2.2 versi resep (Mongo replica set)', { timeout: 90_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  async function call(handler: Handler, method: string, path: string[], body: Json = {}, query = '') {
    const url = new URL(`http://local/api/${path.join('/')}${query}`);
    const res = await handler({
      db, route: `/${path.join('/')}`, method, path, body, url, auth: ADMIN,
      request: new Request(url, { method }),
    } as unknown as HandlerContext);
    expect(res, `${method} /${path.join('/')} tidak ditangani`).toBeTruthy();
    return { status: res!.status, json: await res!.json() as Json };
  }

  const gulaLine = (grams: number) => ({ productId: 'gula', qtyBesar: grams, pctKecil: 100, satuan: 'GR' });
  const revisions = (recipeId: string) => db.collection('recipe_revisions')
    .find({ tenantId: TID, recipeId }).sort({ revision: 1 }).toArray();
  const planCost = async (planId: string) => {
    const res = await call(handleFoodCosts as Handler, 'GET', ['food-costs', 'analyze'], {}, `?scope=plan&id=${planId}`);
    expect(res.status).toBe(200);
    return res.json as Json & { standard: { totalCost: number } };
  };
  const plan = (id: string, recipeId: string) => ({
    id, tenantId: TID, noDokumen: `RPN-${id}`, status: 'SUBMITTED', tanggal: TODAY, kitchenId: 'k1',
    kitchenWarehouseKode: 'GKERING', lines: [{ recipeId, targetPorsi: 100 }],
  });

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('recipe_revisions_it');
    (globalThis as { __recipeRevDb?: Db }).__recipeRevDb = db;
    await db.collection('recipe_revisions').createIndexes([
      { key: { tenantId: 1, recipeId: 1, revision: 1 }, name: 'uniq_recipe_revisions_recipe_rev', unique: true },
      { key: { tenantId: 1, id: 1 }, name: 'uniq_recipe_revisions_id', unique: true },
    ]);
    await db.collection('products').insertOne({
      id: 'gula', tenantId: TID, kode: 'GL01', nama: 'Gula Pasir', satuan: 'KG', itemRole: 'INGREDIENT',
      aktif: true, hargaBeli: 20000, updatedAt: new Date('2026-01-01'),
    });
    await db.collection('kitchens').insertOne({ id: 'k1', tenantId: TID, defaultWarehouseKode: 'GKERING' });
  });

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  let recipeId = '';

  it('POST resep membuat revisi 1 (CREATE) dalam transaksi yang sama', async () => {
    const res = await call(handleRecipes as Handler, 'POST', ['recipes'], {
      nama: 'Kolak', yieldQty: 100, kategoriMenu: 'LAUK_NABATI', lines: [gulaLine(5000)],
    });
    expect(res.status).toBe(200);
    recipeId = String(res.json.id);
    expect(res.json).toMatchObject({ revision: 1 });
    const revs = await revisions(recipeId);
    expect(revs.map((r) => [r.revision, r.reason])).toEqual([[1, 'CREATE']]);
    expect(res.json.currentRevisionId).toBe(revs[0].id);
    expect(revs[0].lines[0]).toMatchObject({ productId: 'gula', qtyBaseBesar: 5 });
    const audit = await db.collection('audit_log').findOne({ tenantId: TID, action: 'RECIPE_CREATE', entityId: recipeId });
    expect(audit?.metadata).toMatchObject({ revision: 1 });
  });

  it('PUT tanpa perubahan isi tidak membuat revisi; perubahan isi membuat revisi 2', async () => {
    const same = await call(handleRecipes as Handler, 'PUT', ['recipes', recipeId], { aktif: true, catatan: 'catatan saja' });
    expect(same.status).toBe(200);
    expect(same.json.revision).toBe(1);
    expect(await revisions(recipeId)).toHaveLength(1);

    const changed = await call(handleRecipes as Handler, 'PUT', ['recipes', recipeId], {
      lines: [gulaLine(6000)], expectedUpdatedAt: same.json.updatedAt,
    });
    expect(changed.status).toBe(200);
    expect(changed.json.revision).toBe(2);
    const revs = await revisions(recipeId);
    expect(revs.map((r) => [r.revision, r.reason])).toEqual([[1, 'CREATE'], [2, 'UPDATE']]);
    expect(revs[0].lines[0].qtyBaseBesar).toBe(5);
    expect(revs[1].lines[0].qtyBaseBesar).toBe(6);
    const audit = await db.collection('audit_log').findOne(
      { tenantId: TID, action: 'RECIPE_UPDATE', entityId: recipeId, 'metadata.revisions.0': { $exists: true } },
    );
    expect(audit?.summary).toMatch(/revisi 2/);
  });

  it('PUT dengan expectedUpdatedAt basi → 409 dan tidak ada revisi/perubahan', async () => {
    const res = await call(handleRecipes as Handler, 'PUT', ['recipes', recipeId], {
      lines: [gulaLine(9999)], expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(res.status).toBe(409);
    expect(await revisions(recipeId)).toHaveLength(2);
    const doc = await db.collection('recipes').findOne({ id: recipeId });
    expect(doc!.lines[0].qtyBaseBesar).toBe(6);
  });

  it('GET riwayat revisi: daftar terbaru dulu + detail satu revisi', async () => {
    const list = await call(handleRecipes as Handler, 'GET', ['recipes', recipeId, 'revisions']);
    expect(list.status).toBe(200);
    const rows = list.json.revisions as Array<Json>;
    expect(rows.map((r) => r.revision)).toEqual([2, 1]);
    expect(rows[0]).toMatchObject({ reason: 'UPDATE', lineCount: 1 });
    expect(rows[0].lines).toBeUndefined();
    const detail = await call(handleRecipes as Handler, 'GET', ['recipes', recipeId, 'revisions', String(rows[1].id)]);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ revision: 1, current: false });
    expect((detail.json.lines as Array<Json>)[0]).toMatchObject({ qtyBaseBesar: 5 });
  });

  it('resep lama tanpa revisi: PUT membuat BACKFILL (isi lama) lalu UPDATE', async () => {
    await db.collection('recipes').insertOne({
      id: 'rcp-legacy', tenantId: TID, kode: 'RSP-LGC', nama: 'Bubur Lama', version: 1, effectiveDate: TODAY,
      aktif: true, yieldQty: 100, updatedAt: new Date('2026-01-01'),
      lines: [{ productId: 'gula', qty: 1000, qtyBesar: 1000, pctKecil: 100, qtyKecil: 1000, satuan: 'GR', qtyBaseBesar: 1, qtyBaseKecil: 1, factorToBase: 0.001, baseSatuan: 'KG', factorSource: 'SI' }],
    });
    const res = await call(handleRecipes as Handler, 'PUT', ['recipes', 'rcp-legacy'], { yieldQty: 50 });
    expect(res.status).toBe(200);
    const revs = await revisions('rcp-legacy');
    expect(revs.map((r) => [r.revision, r.reason, r.yieldQty])).toEqual([[1, 'BACKFILL', 100], [2, 'UPDATE', 50]]);
    expect(res.json).toMatchObject({ revision: 2, currentRevisionId: revs[1].id });
  });

  it('MRP mem-pin revisi resep; HPP rencana tetap setelah resep diedit sampai MRP dihitung ulang', async () => {
    const p = plan('p-kolak', recipeId);
    await db.collection('production_plans').insertOne(p);
    const first = await regenerateMrpForPlan(db, ADMIN, p as never, { actor: { userId: 'u-admin', userName: 'Admin' } });
    expect(first.ok).toBe(true);
    const cur = await db.collection('recipes').findOne({ id: recipeId });
    const mrp = await db.collection('material_requirements').findOne({ tenantId: TID, productionPlanId: 'p-kolak', status: { $ne: 'CANCELLED' } });
    expect(mrp!.recipeRevisions).toEqual([
      expect.objectContaining({ recipeId, revisionId: cur!.currentRevisionId, revision: 2 }),
    ]);
    expect(mrp!.lines[0].sources[0]).toMatchObject({ recipeId, recipeRevisionId: cur!.currentRevisionId });

    const before = await planCost('p-kolak');
    expect(before).toMatchObject({ recipeSource: 'MRP', mrpNo: mrp!.noDokumen });
    // 6 kg × Rp20.000 / 100 porsi × 100 porsi
    expect(before.standard.totalCost).toBe(120000);

    const edit = await call(handleRecipes as Handler, 'PUT', ['recipes', recipeId], { lines: [gulaLine(10000)] });
    expect(edit.json.revision).toBe(3);
    const pinned = await planCost('p-kolak');
    expect(pinned.standard.totalCost).toBe(120000);
    expect(pinned.recipeRevisions).toEqual([expect.objectContaining({ revision: 2 })]);

    const recipeNow = await call(handleFoodCosts as Handler, 'GET', ['food-costs', 'analyze'], {}, `?scope=recipe&id=${recipeId}`);
    const recipeRev2 = await call(handleFoodCosts as Handler, 'GET', ['food-costs', 'analyze'], {}, `?scope=recipe&id=${recipeId}&revisionId=${String(cur!.currentRevisionId)}`);
    expect((recipeNow.json.standard as { totalCost: number }).totalCost).toBe(200000);
    expect((recipeRev2.json.standard as { totalCost: number }).totalCost).toBe(120000);

    const regen = await regenerateMrpForPlan(db, ADMIN, p as never, { actor: { userId: 'u-admin', userName: 'Admin' } });
    expect(regen.ok).toBe(true);
    const after = await planCost('p-kolak');
    expect(after.standard.totalCost).toBe(200000);
    expect(after.recipeRevisions).toEqual([expect.objectContaining({ revision: 3 })]);
  });

  it('rencana tanpa MRP memakai resep terkini (recipeSource LIVE)', async () => {
    await db.collection('production_plans').insertOne(plan('p-live', recipeId));
    const res = await planCost('p-live');
    expect(res.recipeSource).toBe('LIVE');
    expect(res.standard.totalCost).toBe(200000);
  });

  it('MRP dari resep tanpa revisi membuat BACKFILL; sumber basi dipin ke revisi dengan hash yang sama', async () => {
    const legacy = {
      id: 'rcp-mrp', tenantId: TID, kode: 'RSP-MRP', nama: 'Wedang', version: 1, effectiveDate: TODAY,
      aktif: true, yieldQty: 100, updatedAt: new Date('2026-01-01'),
      lines: [{ productId: 'gula', qty: 2000, qtyBesar: 2000, pctKecil: 100, qtyKecil: 2000, satuan: 'GR', qtyBaseBesar: 2, qtyBaseKecil: 2, factorToBase: 0.001, baseSatuan: 'KG', factorSource: 'SI' }],
    };
    await db.collection('recipes').insertOne({ ...legacy });
    const p = plan('p-wedang', 'rcp-mrp');
    await db.collection('production_plans').insertOne(p);
    const res = await regenerateMrpForPlan(db, ADMIN, p as never, { actor: { userId: 'u-admin', userName: 'Admin' } });
    expect(res.ok).toBe(true);
    const revs = await revisions('rcp-mrp');
    expect(revs.map((r) => [r.revision, r.reason])).toEqual([[1, 'BACKFILL']]);
    const mrp = await db.collection('material_requirements').findOne({ tenantId: TID, productionPlanId: 'p-wedang', status: { $ne: 'CANCELLED' } });
    expect(mrp!.recipeRevisions[0]).toMatchObject({ recipeId: 'rcp-mrp', revisionId: revs[0].id });

    // Sumber dibaca sebelum edit (tanpa revisi), resep lalu diedit: pin ke revisi yang isinya sama (BACKFILL), bukan revisi terbaru.
    await call(handleRecipes as Handler, 'PUT', ['recipes', 'rcp-mrp'], { yieldQty: 80 });
    const pins = await ensureRecipeRevisions(db, [legacy as never]);
    expect(pins.get('rcp-mrp')).toMatchObject({ revisionId: revs[0].id, revision: 1 });
  });

  it('migrasi 0002: dry-run tidak menulis; apply beri revisi awal + pin MRP lama; ulang idempoten', async () => {
    await db.collection('recipes').insertOne({
      id: 'rcp-old', tenantId: TID, kode: 'RSP-OLD', nama: 'Es Lama', version: 1, effectiveDate: TODAY,
      aktif: true, yieldQty: 100, updatedAt: new Date('2026-01-01'),
      lines: [{ productId: 'gula', qty: 3000, qtyBesar: 3000, pctKecil: 100, qtyKecil: 3000, satuan: 'GR', qtyBaseBesar: 3, qtyBaseKecil: 3, factorToBase: 0.001, baseSatuan: 'KG', factorSource: 'SI' }],
    });
    await db.collection('material_requirements').insertMany([
      {
        id: 'mrp-old', tenantId: TID, noDokumen: 'MRP-OLD', productionPlanId: 'p-old', status: 'APPROVED',
        createdAt: new Date(), updatedAt: new Date('2026-01-02'), history: [],
        lines: [{ productId: 'gula', qtyGross: 3, sources: [{ recipeId: 'rcp-old', qty: 3 }] }],
        summary: { lineCount: 1, shortageCount: 0 },
      },
      {
        id: 'mrp-cancel', tenantId: TID, noDokumen: 'MRP-CXL', productionPlanId: 'p-old', status: 'CANCELLED',
        createdAt: new Date(), updatedAt: new Date('2026-01-02'), history: [],
        lines: [{ productId: 'gula', qtyGross: 3, sources: [{ recipeId: 'rcp-old', qty: 3 }] }],
        summary: { lineCount: 1, shortageCount: 0 },
      },
    ]);
    const ctx = { db, tenantId: TID, now: new Date(), actor: 'it' };

    const dry = await backfillRecipeRevisionsMigration.run({ ...ctx, dryRun: true });
    expect(dry.changed).toBe(0);
    expect(dry.before).toMatchObject({ recipesWithoutRevision: 1, openMrpsWithoutPins: 1 });
    expect((dry.after as { mrps: Array<Json> }).mrps).toEqual([expect.objectContaining({ mrpId: 'mrp-old', result: 'WOULD_PIN' })]);
    expect(await revisions('rcp-old')).toHaveLength(0);

    const applied = await backfillRecipeRevisionsMigration.run({ ...ctx, dryRun: false });
    expect(applied.changed).toBe(2);
    const revs = await revisions('rcp-old');
    expect(revs.map((r) => [r.revision, r.reason])).toEqual([[1, 'BACKFILL']]);
    const mrp = await db.collection('material_requirements').findOne({ id: 'mrp-old' });
    expect(mrp).toMatchObject({ recipeRevisionsBackfilled: true, updatedAt: new Date('2026-01-02') });
    expect(mrp!.recipeRevisions).toEqual([expect.objectContaining({ recipeId: 'rcp-old', revisionId: revs[0].id })]);
    expect(mrp!.lines[0].sources[0].recipeRevisionId).toBe(revs[0].id);
    const cancelled = await db.collection('material_requirements').findOne({ id: 'mrp-cancel' });
    expect(cancelled!.recipeRevisions).toBeUndefined();

    const again = await backfillRecipeRevisionsMigration.run({ ...ctx, dryRun: false });
    expect(again.changed).toBe(0);
    expect(again.before).toMatchObject({ recipesWithoutRevision: 0, openMrpsWithoutPins: 0 });
  });

  it('PUT dari data basi setelah MRP memberi revisi awal: diulang otomatis, bukan 409', async () => {
    const stale = {
      id: 'rcp-race', tenantId: TID, kode: 'RSP-RACE', nama: 'Setup', version: 1, effectiveDate: TODAY,
      aktif: true, yieldQty: 100, updatedAt: new Date('2026-01-03'),
      lines: [{ productId: 'gula', qty: 500, qtyBesar: 500, pctKecil: 100, qtyKecil: 500, satuan: 'GR', qtyBaseBesar: 0.5, qtyBaseKecil: 0.5, factorToBase: 0.001, baseSatuan: 'KG', factorSource: 'SI' }],
    };
    await db.collection('recipes').insertOne({ ...stale });
    await ensureRecipeRevisions(db, [stale as never]);
    const res = await updateRecipeWithRevision(db, stale as never, { yieldQty: 90, updatedAt: new Date() }, {
      now: new Date(),
      audit: () => ({ tenantId: TID, action: 'RECIPE_UPDATE', entityType: 'recipe', entityId: 'rcp-race', summary: 'x' }),
    });
    expect(res.ok).toBe(true);
    expect((await revisions('rcp-race')).map((r) => [r.revision, r.reason])).toEqual([[1, 'BACKFILL'], [2, 'UPDATE']]);

    // Diedit sungguhan oleh orang lain (updatedAt berubah) → tetap konflik.
    const again = await updateRecipeWithRevision(db, stale as never, { yieldQty: 70, updatedAt: new Date() }, {
      now: new Date(),
      audit: () => ({ tenantId: TID, action: 'RECIPE_UPDATE', entityType: 'recipe', entityId: 'rcp-race', summary: 'x' }),
    });
    expect(again).toEqual({ ok: false, conflict: true });
    expect(await revisions('rcp-race')).toHaveLength(2);
  });

  it('HPP memakai MRP terbaru rencana; bila MRP terbaru belum berpin → resep terkini', async () => {
    await db.collection('production_plans').insertOne(plan('p-two', recipeId));
    const cur = await db.collection('recipes').findOne({ id: recipeId });
    await db.collection('material_requirements').insertMany([
      {
        id: 'mrp-two-old', tenantId: TID, noDokumen: 'MRP-TWO-OLD', productionPlanId: 'p-two', status: 'APPROVED',
        createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), lines: [],
        recipeRevisions: [{ recipeId, revisionId: (await revisions(recipeId))[0].id, revision: 1 }],
      },
      {
        id: 'mrp-two-new', tenantId: TID, noDokumen: 'MRP-TWO-NEW', productionPlanId: 'p-two', status: 'DRAFT',
        createdAt: new Date('2026-02-01'), updatedAt: new Date('2026-02-01'), lines: [],
      },
    ]);
    const res = await planCost('p-two');
    expect(res.recipeSource).toBe('LIVE');
    expect(res.mrpNo).toBeUndefined();
    expect(cur!.revision).toBeGreaterThan(1);
  });

  it('index unik menolak nomor revisi ganda per resep', async () => {
    const [rev] = await revisions(recipeId);
    await expect(db.collection('recipe_revisions').insertOne({ ...rev, _id: undefined, id: 'dup-rev' })).rejects.toMatchObject({ code: 11000 });
  });
});
