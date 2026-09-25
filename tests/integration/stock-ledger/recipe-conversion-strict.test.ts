/**
 * Fase 2.1 — konversi resep ketat (strictRecipeConversion) pada Mongo replica set:
 * simpan/impor resep, konfirmasi jembatan, review, migrasi recompute + regen MRP, rebase cutover.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import type { HandlerContext } from '@/types/api/handler';

vi.mock('@/lib/api/transaction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/transaction')>('@/lib/api/transaction');
  const testDb = () => (globalThis as { __recipeConvDb?: Db }).__recipeConvDb!;
  return {
    ...actual,
    runInTransactionOrFallback: (fn: Parameters<typeof actual.runInTransactionOrFallback>[0]) => (
      actual.runInTransactionOnDb(testDb(), fn)
    ),
  };
});

const { handleRecipes } = await import('@/lib/api/handlers/recipes');
const { handleRecipeConversion } = await import('@/lib/api/handlers/recipe-conversion');
const { buildPlanMaterialExplosion } = await import('@/lib/api/handlers/material-requirements');
const { recomputeRecipeConversionMigration } = await import('@/lib/migrations/0001-recompute-recipe-conversion');
const { buildRecipeConversionReview } = await import('@/lib/api/recipe-conversion-review');
const { parseRecipeImportAoa, RECIPE_IMPORT_HEADERS } = await import('@/lib/food-production/recipe-import');
const XLSX = await import('xlsx');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-21';
const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const ADMIN = {
  userId: 'u-admin', role: 'ADMIN', tenantId: TID, name: 'Admin', email: 'a@x', isMaster: false,
} as AuthContext;

type Handler = (ctx: HandlerContext) => Promise<Response | null>;

describe.skipIf(!MongoMemoryReplSet)('Fase 2.1 konversi resep ketat (Mongo replica set)', { timeout: 90_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  async function call(handler: Handler, method: string, path: string[], body: Record<string, unknown> = {}, query = '') {
    const url = new URL(`http://local/api/${path.join('/')}${query}`);
    const res = await handler({
      db, route: `/${path.join('/')}`, method, path, body, url, auth: ADMIN,
      request: new Request(url, { method }),
    } as unknown as HandlerContext);
    expect(res, `${method} /${path.join('/')} tidak ditangani`).toBeTruthy();
    return { status: res!.status, json: await res!.json() as Record<string, unknown> };
  }

  const setStrict = (on: boolean) => db.collection('tenant_settings').updateOne(
    { tenantId: TID },
    { $set: { 'features.strictRecipeConversion': on } },
    { upsert: true },
  );

  const product = (id: string, kode: string, nama: string, satuan: string, extra: Record<string, unknown> = {}) => ({
    id, tenantId: TID, kode, nama, satuan, itemRole: 'INGREDIENT', aktif: true, updatedAt: new Date('2026-01-01'), ...extra,
  });

  const postRecipe = (nama: string, lines: Array<Record<string, unknown>>) => call(handleRecipes as Handler, 'POST', ['recipes'], {
    nama, yieldQty: 100, kategoriMenu: 'LAUK_NABATI', lines,
  });

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('recipe_conversion_it');
    (globalThis as { __recipeConvDb?: Db }).__recipeConvDb = db;
    await db.collection('products').insertMany([
      product('gula', 'GL01', 'Gula Pasir', 'KG'),
      product('saori', 'SAORI', 'Saori Saus Tiram', 'BTL', { nutrition: { gramsPerUnit: 100 } }),
      product('kaldu', 'KALDU', 'Royco Kaldu Ayam 12,5 g', 'RTG'),
      product('kecap-old', 'KCP-OLD', 'Kecap Manis lama', 'KG', { aktif: false, cutoverToKode: 'KCP-NEW' }),
      product('kecap-new', 'KCP-NEW', 'Kecap Manis 600 g', 'BTL', { recipeBaseGrams: 600, recipeBridgeSource: 'MASTER' }),
    ]);
    await db.collection('kitchens').insertOne({ id: 'k1', tenantId: TID, defaultWarehouseKode: 'GKERING' });
  });

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('mode lama: faktor nutrisi masih diterima dan dicatat sebagai NUTRITION', async () => {
    await setStrict(false);
    const res = await postRecipe('Tumis Saori', [
      { productId: 'saori', qtyBesar: 200, pctKecil: 100, satuan: 'GR' },
      { productId: 'gula', qtyBesar: 50, pctKecil: 100, satuan: 'GR' },
    ]);
    expect(res.status).toBe(200);
    const lines = res.json.lines as Array<Record<string, unknown>>;
    expect(lines[0]).toMatchObject({ productId: 'saori', qtyBaseBesar: 2, factorSource: 'NUTRITION' });
    expect(lines[1]).toMatchObject({ qtyBaseBesar: 0.05, factorSource: 'SI' });
  });

  it('mode ketat: simpan ditolak dengan daftar semua bahan bermasalah', async () => {
    await setStrict(true);
    const res = await postRecipe('Sup Kaldu', [
      { productId: 'saori', qtyBesar: 200, pctKecil: 100, satuan: 'GR' },
      { productId: 'kaldu', qtyBesar: 25, pctKecil: 100, satuan: 'GR' },
      { productId: 'gula', qtyBesar: 10, pctKecil: 100, satuan: '' },
    ]);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('RECIPE_CONVERSION_INVALID');
    const issues = res.json.conversionIssues as Array<Record<string, unknown>>;
    expect(issues.map((i) => [i.productId, i.code])).toEqual([
      ['saori', 'NO_BRIDGE'],
      ['kaldu', 'NO_BRIDGE'],
      ['gula', 'EMPTY_SATUAN'],
    ]);
    expect(String(res.json.error)).toMatch(/3 bahan/);
  });

  it('konfirmasi tebakan nama + isi per kemasan → resep SACHET lolos mode ketat', async () => {
    const confirmed = await call(handleRecipeConversion as Handler, 'POST', ['recipe-conversion', 'products', 'kaldu'], {
      isiPerKemasan: 10, satuanIsi: 'sachet', confirmInferred: true,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json).toMatchObject({
      recipeBaseGrams: 125, isiPerKemasan: 10, satuanIsi: 'SACHET', recipeBridgeSource: 'CONFIRMED_INFER',
    });
    const audit = await db.collection('audit_log').findOne({ tenantId: TID, action: 'PRODUCT_RECIPE_BRIDGE', entityId: 'kaldu' });
    expect(audit?.metadata).toMatchObject({ source: 'CONFIRMED_INFER', after: { recipeBaseGrams: 125 } });

    const res = await postRecipe('Sup Kaldu', [
      { productId: 'kaldu', qtyBesar: 2, pctKecil: 100, satuan: 'SACHET' },
      { productId: 'gula', qtyBesar: 25, pctKecil: 100, satuan: 'GR' },
    ]);
    expect(res.status).toBe(200);
    const lines = res.json.lines as Array<Record<string, unknown>>;
    expect(lines[0]).toMatchObject({ satuan: 'SACHET', qtyBaseBesar: 0.2, factorSource: 'ISI' });
    expect(lines[1]).toMatchObject({ qtyBaseBesar: 0.025 });
  });

  it('impor mode ketat: satuan kosong & bahan tanpa konversi ditandai di preview', async () => {
    const products = await db.collection('products').find({ tenantId: TID, aktif: true }).toArray();
    const parsed = parseRecipeImportAoa([
      [...RECIPE_IMPORT_HEADERS],
      ['Impor A', 100, TODAY, 0, '', 'GL01', 'Gula Pasir', 10, 100, '', ''],
    ], products.map((p) => ({ id: String(p.id), kode: String(p.kode), nama: String(p.nama), satuan: String(p.satuan), itemRole: 'INGREDIENT' })), { requireSatuan: true });
    expect(parsed.recipes[0].ok).toBe(false);
    expect(parsed.recipes[0].errors.join(' ')).toMatch(/satuan kosong/);

    const res = await call(handleRecipes as Handler, 'POST', ['recipes', 'import'], {
      source: 'excel',
      dryRun: true,
      excelBase64: xlsxBase64([
        ['Impor B', 100, TODAY, 0, '', 'SAORI', 'Saori Saus Tiram', 100, 100, 'GR', ''],
      ]),
    });
    expect(res.status).toBe(200);
    const recipes = res.json.recipes as Array<{ ok: boolean; errors: string[] }>;
    expect(recipes[0].ok).toBe(false);
    expect(recipes[0].errors.join(' ')).toMatch(/Saori/);
  });

  it('review + migrasi: dry-run tidak menulis, apply menghitung ulang resep dan MRP rencana belum Diproses', async () => {
    const recipe = await db.collection('recipes').findOne({ tenantId: TID, nama: 'Tumis Saori' });
    expect(recipe).toBeTruthy();
    await db.collection('production_plans').insertMany([
      {
        id: 'plan-open', tenantId: TID, noDokumen: 'RPN-OPEN', status: 'SUBMITTED', tanggal: TODAY, kitchenId: 'k1',
        kitchenWarehouseKode: 'GKERING', lines: [{ recipeId: recipe!.id, targetPorsi: 100 }],
      },
      {
        id: 'plan-done', tenantId: TID, noDokumen: 'RPN-DONE', status: 'PROCESSING', tanggal: TODAY, kitchenId: 'k1',
        kitchenWarehouseKode: 'GKERING', lines: [{ recipeId: recipe!.id, targetPorsi: 100 }],
      },
    ]);
    await db.collection('material_requirements').insertMany([
      {
        id: 'mrp-open', tenantId: TID, noDokumen: 'MRP-OPEN', productionPlanId: 'plan-open', status: 'DRAFT',
        createdAt: new Date(), updatedAt: new Date('2026-01-01'), history: [],
        lines: [{ productId: 'saori', satuan: 'BTL', qtyGross: 2 }], summary: { lineCount: 1, shortageCount: 1 },
      },
      {
        id: 'mrp-done', tenantId: TID, noDokumen: 'MRP-DONE', productionPlanId: 'plan-done', status: 'APPROVED',
        createdAt: new Date(), updatedAt: new Date('2026-01-01'), history: [],
        lines: [{ productId: 'saori', satuan: 'BTL', qtyGross: 2 }], summary: { lineCount: 1, shortageCount: 1 },
      },
    ]);

    let review = await buildRecipeConversionReview(db, TID);
    expect(review.summary.fallbackLines).toBe(1);
    expect(review.products.find((p) => p.productId === 'saori')?.status).toBe('INVALID');

    const saved = await call(handleRecipeConversion as Handler, 'POST', ['recipe-conversion', 'products', 'saori'], {
      recipeBaseGrams: 1100,
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ recipeBaseGrams: 1100, recipeBridgeSource: 'MASTER' });

    review = await buildRecipeConversionReview(db, TID);
    const saoriRow = review.products.find((p) => p.productId === 'saori')!.lines[0];
    expect(saoriRow.status).toBe('STALE');
    expect(saoriRow.after?.qtyBaseBesar).toBeCloseTo(200 / 1100, 9);

    const ctx = { db, tenantId: TID, now: new Date(), actor: 'it' };
    const dry = await recomputeRecipeConversionMigration.run({ ...ctx, dryRun: true });
    expect(dry.changed).toBe(0);
    const dryAfter = dry.after as { recipes: Array<{ result: string }>; plans: Array<{ planId: string; result: string }>; lines: Array<{ productId: string; before: { qtyBaseBesar: number }; after: { qtyBaseBesar: number } | null }> };
    expect(dryAfter.recipes.some((r) => r.result === 'WOULD_UPDATE')).toBe(true);
    expect(dryAfter.plans).toEqual([expect.objectContaining({ planId: 'plan-open', result: 'WOULD_REGENERATE' })]);
    const saoriLine = dryAfter.lines.find((l) => l.productId === 'saori')!;
    expect(saoriLine.before.qtyBaseBesar).toBe(2);
    expect(saoriLine.after?.qtyBaseBesar).toBeCloseTo(200 / 1100, 9);
    expect((await db.collection('recipes').findOne({ id: recipe!.id }))!.lines[0].qtyBaseBesar).toBe(2);

    const applied = await recomputeRecipeConversionMigration.run({ ...ctx, dryRun: false });
    expect(applied.changed).toBeGreaterThanOrEqual(2);
    const after = await db.collection('recipes').findOne({ id: recipe!.id });
    expect(after!.lines[0]).toMatchObject({ factorSource: 'MASTER' });
    expect(after!.lines[0].qtyBaseBesar).toBeCloseTo(200 / 1100, 9);

    const mrpOpen = await db.collection('material_requirements').findOne({ id: 'mrp-open' });
    const saoriMrp = (mrpOpen!.lines as Array<{ productId: string; qtyGross: number; sources: Array<{ qty: number }> }>)
      .find((l) => l.productId === 'saori');
    expect(saoriMrp?.sources[0].qty).toBeCloseTo(200 / 1100, 3);
    expect(saoriMrp?.qtyGross).toBe(1);
    const mrpDone = await db.collection('material_requirements').findOne({ id: 'mrp-done' });
    expect(mrpDone!.lines[0].qtyGross).toBe(2);

    const auditRecompute = await db.collection('audit_log').countDocuments({ tenantId: TID, action: 'RECIPE_CONVERSION_RECOMPUTE' });
    expect(auditRecompute).toBeGreaterThanOrEqual(1);
    const revs = await db.collection('recipe_revisions').find({ tenantId: TID, recipeId: recipe!.id }).sort({ revision: 1 }).toArray();
    expect(revs.map((r) => r.reason)).toEqual(['CREATE', 'RECOMPUTE']);
    expect(after!.currentRevisionId).toBe(revs[1].id);
    expect(revs[1].lines[0].qtyBaseBesar).toBeCloseTo(200 / 1100, 9);
    expect(mrpOpen!.recipeRevisions).toEqual([expect.objectContaining({ recipeId: recipe!.id, revisionId: revs[1].id })]);

    review = await buildRecipeConversionReview(db, TID);
    expect(review.summary.fallbackLines).toBe(0);
    expect(review.summary.staleLines).toBe(0);
    expect(review.summary.invalidLines).toBe(0);

    const again = await recomputeRecipeConversionMigration.run({ ...ctx, dryRun: true });
    expect((again.after as { recipes: unknown[] }).recipes).toEqual([]);
  });

  it('cutover: MRP menghitung ulang qtyBase dengan faktor produk pengganti', async () => {
    await db.collection('recipes').insertOne({
      id: 'rcp-kecap', tenantId: TID, kode: 'RSP-KCP', nama: 'Tahu Kecap', aktif: true, yieldQty: 100, updatedAt: new Date(),
      lines: [{
        productId: 'kecap-old', productKode: 'KCP-OLD', qty: 300, qtyBesar: 300, pctKecil: 100, qtyKecil: 300,
        satuan: 'GR', qtyBaseBesar: 0.3, qtyBaseKecil: 0.3, factorToBase: 0.001, baseSatuan: 'KG', factorSource: 'SI',
      }],
    });
    const plan = {
      id: 'plan-kecap', tenantId: TID, noDokumen: 'RPN-KCP', status: 'SUBMITTED', tanggal: TODAY, kitchenId: 'k1',
      kitchenWarehouseKode: 'GKERING', lines: [{ recipeId: 'rcp-kecap', targetPorsi: 100 }],
    };
    const scope = { ...ADMIN };
    const built = await buildPlanMaterialExplosion(db, scope, plan as never);
    expect('error' in built).toBe(false);
    const line = (built as { lines: Array<{ productId: string; satuan: string; qtyGross: number; sources: Array<{ qty: number }> }> }).lines
      .find((l) => l.productId === 'kecap-new');
    expect(line?.satuan).toBe('BTL');
    expect(line?.sources[0].qty).toBeCloseTo(300 / 600, 6);

    await db.collection('products').updateOne({ id: 'kecap-new' }, { $unset: { recipeBaseGrams: '' } });
    const blocked = await buildPlanMaterialExplosion(db, scope, plan as never);
    expect('error' in blocked && String(blocked.error)).toMatch(/pengganti/);
  });

  it('MRP mode ketat: snapshot non-cutover basi/nutrisi tidak pernah dipakai', async () => {
    await db.collection('products').insertOne(
      product('tiram', 'TIRAM', 'Saus Tiram Botol', 'BTL', { nutrition: { gramsPerUnit: 100 } }),
    );
    await db.collection('recipes').insertOne({
      id: 'rcp-tiram', tenantId: TID, kode: 'RSP-TRM', nama: 'Cah Tiram', aktif: true, yieldQty: 100, updatedAt: new Date(),
      lines: [{
        productId: 'tiram', productKode: 'TIRAM', qty: 200, qtyBesar: 200, pctKecil: 100, qtyKecil: 200,
        satuan: 'GR', qtyBaseBesar: 2, qtyBaseKecil: 2, factorToBase: 0.01, baseSatuan: 'BTL', factorSource: 'NUTRITION',
      }],
    });
    const plan = {
      id: 'plan-tiram', tenantId: TID, noDokumen: 'RPN-TRM', status: 'SUBMITTED', tanggal: TODAY, kitchenId: 'k1',
      kitchenWarehouseKode: 'GKERING', lines: [{ recipeId: 'rcp-tiram', targetPorsi: 100 }],
    };
    const tiramLine = (b: unknown) => (b as { lines: Array<{ productId: string; sources: Array<{ qty: number }> }> }).lines
      .find((l) => l.productId === 'tiram');

    await setStrict(false);
    const legacy = await buildPlanMaterialExplosion(db, { ...ADMIN }, plan as never);
    expect(tiramLine(legacy)?.sources[0].qty).toBeCloseTo(2, 6);

    await setStrict(true);
    const blocked = await buildPlanMaterialExplosion(db, { ...ADMIN }, plan as never);
    expect('error' in blocked && String(blocked.error)).toMatch(/Saus Tiram|TIRAM/);

    await db.collection('products').updateOne({ id: 'tiram' }, { $set: { recipeBaseGrams: 500 } });
    const fixed = await buildPlanMaterialExplosion(db, { ...ADMIN }, plan as never);
    expect('error' in fixed).toBe(false);
    expect(tiramLine(fixed)?.sources[0].qty).toBeCloseTo(200 / 500, 6);
  });
});

function xlsxBase64(rows: unknown[][]): string {
  const ws = XLSX.utils.aoa_to_sheet([[...RECIPE_IMPORT_HEADERS], ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Resep');
  return (XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer).toString('base64');
}
