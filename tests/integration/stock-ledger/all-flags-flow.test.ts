/**
 * Alur harian lengkap dengan semua flag kelola bahan menyala bersamaan:
 * GRN (kedaluwarsa wajib, QC karantina, cadangan rencana) → inspeksi → prefill RL → RL rencana
 * (costingV2 + jurnal) → PBL acuan → penyesuaian maker-checker → resep ketat → rekonsiliasi.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import type { HandlerContext } from '@/types/api/handler';

vi.mock('@/lib/api/transaction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/transaction')>('@/lib/api/transaction');
  const testDb = () => (globalThis as { __allFlagsDb?: Db }).__allFlagsDb!;
  return {
    ...actual,
    runInTransactionOrFallback: (fn: Parameters<typeof actual.runInTransactionOrFallback>[0]) => (
      actual.runInTransactionOnDb(testDb(), fn)
    ),
  };
});

const { applyGrnStockPosting } = await import('@/lib/api/grn-post-stock');
const { inspectIngredientLot } = await import('@/lib/stock-ledger/lot-qc');
const { loadReleasePrefill } = await import('@/lib/food-production/release-prefill');
const { handleInventoryReleases } = await import('@/lib/api/handlers/inventory-releases');
const { handleMaterialIssues } = await import('@/lib/api/handlers/material-issues');
const { handlePenyesuaian } = await import('@/lib/api/handlers/inventory-penyesuaian');
const { handleRecipes } = await import('@/lib/api/handlers/recipes');
const { runReconForTenant } = await import('@/lib/recon/run');
const { RECON_JOBS } = await import('@/lib/recon/types');
const { OPT_IN_FEATURE_FLAGS } = await import('@/lib/api/feature-flags');
const { businessDateIso, addShelfDays } = await import('@/lib/food-production/ingredient-lot');

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-all-flags';
const TODAY = businessDateIso();

const user = (userId: string, role: string): AuthContext => ({
  userId, role, tenantId: TID, tenantName: TID, name: userId, email: `${userId}@x`, isMaster: false,
} as AuthContext);
const GUDANG = user('u-gudang', 'GUDANG');
const SPV = user('u-spv', 'SUPERVISOR');
const ADMIN = user('u-admin', 'ADMIN');

type Handler = (ctx: HandlerContext) => Promise<Response | null>;

describe.skipIf(!MongoMemoryReplSet)('Semua flag kelola bahan menyala (Mongo replica set)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  async function call(handler: Handler, auth: AuthContext, method: string, path: string[], body: Record<string, unknown> = {}) {
    const url = new URL(`http://local/api/${path.join('/')}`);
    const request = Object.assign(new Request(url, { method }), { cookies: { get: () => ({ value: TID }) } });
    const res = await handler({
      db, route: `/${path.join('/')}`, method, path, body, url, auth, request,
    } as unknown as HandlerContext);
    expect(res, `${method} /${path.join('/')} tidak ditangani`).toBeTruthy();
    return { status: res!.status, json: await res!.json() as Record<string, unknown> };
  }
  const releases = (auth: AuthContext, method: string, path: string[], body: Record<string, unknown> = {}) => (
    call(handleInventoryReleases as Handler, auth, method, ['inventory-releases', ...path], body)
  );
  const issues = (method: string, path: string[], body: Record<string, unknown> = {}) => (
    call(handleMaterialIssues as Handler, ADMIN, method, ['material-issues', ...path], body)
  );
  const stockOf = async (stokId: string) => Number(
    (await db.collection('stok_lokasi').findOne({ tenantId: TID, stokId, lokasiKode: 'GKERING' }))?.qty ?? 0,
  );
  const lotsOf = (grnId: string) => db.collection('ingredient_lots').find({ tenantId: TID, grnId }).sort({ lineIndex: 1 }).toArray();

  const grn = {
    id: 'grn-a', tenantId: TID, noGRN: 'GRN-ALL-1', noDO: 'DO-ALL-1', noPO: 'CPO-A', vendorTenantId: 'v1',
    items: [
      { lineId: 'l0', localStokId: 'beras', vendorKode: 'BERAS', qtyOrdered: 10, qtyBase: 10, satuan: 'KG', harga: 12000 },
      { lineId: 'l1', localStokId: 'minyak', vendorKode: 'MINYAK', qtyOrdered: 4, qtyBase: 4, satuan: 'KG', harga: 20000 },
    ],
  };

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('all_flags_it');
    (globalThis as { __allFlagsDb?: Db }).__allFlagsDb = db;
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });

    await db.collection('tenant_settings').insertOne({
      tenantId: TID,
      features: Object.fromEntries(OPT_IN_FEATURE_FLAGS.map((f) => [f, true])),
    });
    const product = (id: string, nama: string, satuan: string, extra: Record<string, unknown> = {}) => ({
      id, tenantId: TID, kode: id.toUpperCase(), nama, satuan, itemRole: 'INGREDIENT', aktif: true, syncSource: 'local',
      gudangKode: 'GKERING', hargaBeli: 10000, stok: 0, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...extra,
    });
    await db.collection('products').insertMany([
      product('beras', 'Beras', 'KG'),
      product('minyak', 'Minyak Goreng', 'KG', { shelfLifeDays: 180 }),
      product('kaldu', 'Royco Kaldu Ayam 12,5 g', 'RTG'),
    ]);
    await db.collection('product_uom').insertMany(['beras', 'minyak', 'kaldu'].map((id) => ({
      id: `u-${id}`, tenantId: TID, productId: id, satuan: id === 'kaldu' ? 'RTG' : 'KG', isBase: true, factorToBase: 1, aktif: true, sortOrder: 0,
    })));
    await db.collection('kitchens').insertOne({ id: 'k1', tenantId: TID, defaultWarehouseKode: 'GKERING' });
    await db.collection('recipes').insertOne({
      id: 'rcp-nasi', tenantId: TID, kode: 'RCP-NASI', nama: 'Nasi', yieldQty: 1, aktif: true,
      lines: [{ productId: 'beras', qty: 1, qtyBesar: 1, pctKecil: 100, qtyKecil: 1, satuan: 'KG' }],
    });
    for (const id of ['plan-a', 'plan-b']) {
      await db.collection('production_plans').insertOne({
        id, tenantId: TID, noDokumen: id.toUpperCase(), status: 'APPROVED', tanggal: TODAY, kitchenId: 'k1',
        kitchenWarehouseKode: 'GKERING', lines: [{ recipeId: 'rcp-nasi', targetPorsi: 1 }],
      });
    }
    await db.collection('material_requirements').insertOne({
      id: 'mrp-a', tenantId: TID, noDokumen: 'MRP-A', productionPlanId: 'plan-a', status: 'APPROVED', createdAt: new Date(),
      lines: [
        { productId: 'beras', productNama: 'Beras', satuan: 'KG', qtyGross: 10 },
        { productId: 'minyak', productNama: 'Minyak Goreng', satuan: 'KG', qtyGross: 4 },
      ],
    });
    await db.collection('customer_purchase_orders').insertOne({
      id: 'po-a', tenantId: TID, noPO: 'CPO-A', productionPlanId: 'plan-a', status: 'RECEIVED', createdAt: new Date(),
      items: [
        { localStokId: 'beras', kode: 'BERAS', satuan: 'KG', qty: 10, qtyReceived: 0 },
        { localStokId: 'minyak', kode: 'MINYAK', satuan: 'KG', qty: 4, qtyReceived: 0 },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    delete (globalThis as { __allFlagsDb?: Db }).__allFlagsDb;
    await client?.close();
    await rs?.stop();
  });

  it('GRN: tanpa kedaluwarsa ditolak; dengan isian → lot karantina + cadangan rencana pemilik PO', async () => {
    const receiver = { userId: 'u-gudang', userName: 'Penerima' } as never;
    const rejected = await applyGrnStockPosting(db, TID, grn as never, [], undefined, receiver);
    expect(rejected.error).toMatch(/Tanggal kedaluwarsa wajib untuk Beras/);
    expect(await stockOf('beras')).toBe(0);

    const exp = addShelfDays(TODAY, 90);
    const ok = await applyGrnStockPosting(db, TID, grn as never, [
      { lineIndex: 0, qty: 10, expiryDate: exp },
      { lineIndex: 1, qty: 4 },
    ], undefined, receiver);
    expect(ok.error).toBeUndefined();
    const lots = await lotsOf(grn.id);
    expect(lots.map((l) => [l.productId, l.expirySource, l.qcStatus])).toEqual([
      ['beras', 'INPUT', 'QUARANTINE'],
      ['minyak', 'MASTER_SHELF', 'QUARANTINE'],
    ]);
    const allocs = await db.collection('stock_allocations').find({ tenantId: TID, status: 'ACTIVE' }).toArray();
    expect(allocs.map((a) => [a.productId ?? a.stokId, a.productionPlanId, a.qtyRemaining]).sort()).toEqual([
      ['beras', 'plan-a', 10],
      ['minyak', 'plan-a', 4],
    ]);
    expect(await stockOf('beras')).toBe(10);
    const kartu = await db.collection('stok_kartu').findOne({ tenantId: TID, sourceId: grn.id, stokId: 'beras' });
    expect(kartu).toMatchObject({ hargaSatuan: 12000, lineRef: expect.any(String) });
  });

  it('sebelum QC: prefill tidak mengusulkan qty karantina; RL rencana ditolak saat dibuat', async () => {
    const prefill = await loadReleasePrefill(db, ADMIN, { id: 'plan-a', tenantId: TID }, { lokasiKode: 'GKERING' });
    expect(prefill.lines.filter((l) => l.qty > 0)).toEqual([]);

    const rl = await releases(GUDANG, 'POST', [], {
      lokasiKode: 'GKERING', keperluan: 'Masak menu produksi', productionPlanId: 'plan-a',
      items: [{ stokId: 'beras', qty: 2, satuan: 'KG' }], submit: true,
    });
    expect(rl.status).toBe(400);
    expect(String(rl.json.error)).toMatch(/karantina QC/);
    expect(await stockOf('beras')).toBe(10);
  });

  it('inspeksi QC: penerima tidak boleh memeriksa; Supervisor lain merilis lot, cadangan tetap utuh', async () => {
    const lots = await lotsOf(grn.id);
    const sod = await inspectIngredientLot(db, {
      tenantId: TID, lotId: String(lots[0].id), kondisi: 'BAIK', qtyPassed: 10, qtyFailed: 0,
      actor: { userId: 'u-gudang', userName: 'Penerima', role: 'SUPERVISOR' },
    } as never);
    expect(sod).toMatchObject({ ok: false, status: 403 });
    for (const lot of lots) {
      const res = await inspectIngredientLot(db, {
        tenantId: TID, lotId: String(lot.id), kondisi: 'BAIK', qtyPassed: Number(lot.qty), qtyFailed: 0,
        actor: { userId: 'u-spv', userName: 'Supervisor', role: 'SUPERVISOR' },
      } as never);
      expect(res.ok, JSON.stringify(res)).toBe(true);
    }
    expect((await lotsOf(grn.id)).map((l) => l.qcStatus)).toEqual(['RELEASED', 'RELEASED']);
    expect(await db.collection('stock_allocations').countDocuments({ tenantId: TID, status: 'ACTIVE' })).toBe(2);
  });

  it('RL bahan rencana tanpa pilihan rencana ditolak; RL non-produksi tidak bisa memakai lot cadangan', async () => {
    const ambiguous = await releases(GUDANG, 'POST', [], {
      lokasiKode: 'GKERING', keperluan: 'Kebersihan kantor', items: [{ stokId: 'beras', qty: 2, satuan: 'KG' }], submit: true,
    });
    expect(ambiguous.status).toBe(400);
    expect(String(ambiguous.json.error)).toMatch(/Pilih Rencana Produksi/);

    const rl = await releases(GUDANG, 'POST', [], {
      lokasiKode: 'GKERING', keperluan: 'Cuci peralatan dapur', items: [{ stokId: 'beras', qty: 2, satuan: 'KG' }], submit: true,
    });
    if (rl.status === 200) {
      const approve = await releases(SPV, 'POST', [String(rl.json.id), 'approve']);
      expect(approve.status).not.toBe(200);
      expect(JSON.stringify(approve.json)).toMatch(/cadangan/i);
      expect((await releases(SPV, 'POST', [String(rl.json.id), 'reject'], { reason: 'Stok milik rencana' })).status).toBe(200);
    } else {
      expect(String(rl.json.error)).toMatch(/cadangan/i);
    }
    expect(await stockOf('beras')).toBe(10);
  });

  it('prefill → RL rencana: stok & cadangan terpakai, kartu dinilai rata-rata, jurnal pemakaian terbentuk', async () => {
    const prefill = await loadReleasePrefill(db, ADMIN, { id: 'plan-a', tenantId: TID }, { lokasiKode: 'GKERING' });
    expect(prefill.lines.map((l) => [l.stokId, l.qty]).sort()).toEqual([['beras', 10], ['minyak', 4]]);

    const rl = await releases(GUDANG, 'POST', [], {
      lokasiKode: 'GKERING', keperluan: 'Masak menu produksi', productionPlanId: 'plan-a',
      items: prefill.lines.map((l) => ({ stokId: l.stokId, qty: l.qty, satuan: l.satuan, uomId: l.uomId })),
      submit: true,
    });
    expect(rl.status, JSON.stringify(rl.json)).toBe(200);
    expect((await releases(GUDANG, 'POST', [String(rl.json.id), 'approve'])).status).toBe(403);
    const approve = await releases(SPV, 'POST', [String(rl.json.id), 'approve']);
    expect(approve.status, JSON.stringify(approve.json)).toBe(200);
    expect(approve.json.status).toBe('POSTED');

    expect(await stockOf('beras')).toBe(0);
    expect(await stockOf('minyak')).toBe(0);
    expect(await db.collection('stock_allocations').countDocuments({ tenantId: TID, status: 'ACTIVE' })).toBe(0);
    const out = await db.collection('stok_kartu').find({ tenantId: TID, sourceType: 'RELEASE', sourceId: rl.json.id }).toArray();
    expect(out.map((k) => [k.stokId, k.hargaSatuan]).sort()).toEqual([['beras', 12000], ['minyak', 20000]]);
    const j = await db.collection('jurnal').find({ tenantId: TID, sourceType: 'AUTO_RL_CONSUMPTION' }).toArray();
    expect(j).toHaveLength(1);
  });

  it('PBL acuan: selesai tanpa memotong stok, tidak ada kartu FP_ISSUE', async () => {
    const created = await issues('POST', [], { productionPlanId: 'plan-a' });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(created.json.stockMode).toBe('REFERENCE');
    const id = String(created.json.id);
    expect((await issues('POST', [id, 'status'], { status: 'SUBMITTED' })).status).toBe(200);
    expect((await issues('POST', [id, 'status'], { status: 'APPROVED' })).status).toBe(200);
    const done = await issues('POST', [id, 'status'], { status: 'COMPLETED' });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.stockPostedAt).toBeUndefined();
    expect(await db.collection('stok_kartu').countDocuments({ tenantId: TID, sourceType: 'FP_ISSUE' })).toBe(0);
  });

  it('penyesuaian: pembuat tidak bisa menyetujui; selisih lebih masuk ke lot rilis yang ada (tanpa lot default)', async () => {
    const adj = (who: AuthContext, method: string, path: string[], body: Record<string, unknown> = {}) => (
      call(handlePenyesuaian as Handler, who, method, ['stok', 'penyesuaian', ...path], body)
    );
    const draft = await adj(GUDANG, 'POST', [], { items: [{ stokId: 'beras' }] });
    expect(draft.status, JSON.stringify(draft.json)).toBe(200);
    const id = String(draft.json.id);
    expect((await adj(GUDANG, 'PUT', [id], { reasonCode: 'OPNAME', items: [{ stokId: 'beras', qtyAktual: 1 }] })).status).toBe(200);
    expect((await adj(GUDANG, 'POST', [id, 'submit'])).json.status).toBe('PENDING_APPROVAL');
    expect((await adj(GUDANG, 'POST', [id, 'approve'])).status).toBe(403);
    const approve = await adj(SPV, 'POST', [id, 'approve']);
    expect(approve.status, JSON.stringify(approve.json)).toBe(200);
    expect(approve.json.status).toBe('POSTED');
    expect(await stockOf('beras')).toBe(1);
    const [berasLot] = await lotsOf(grn.id);
    expect(berasLot).toMatchObject({ qtyRemaining: 1, expirySource: 'INPUT', qcStatus: 'RELEASED' });
    expect(await db.collection('ingredient_lots').countDocuments({ tenantId: TID, expirySource: 'DEFAULT' })).toBe(0);
  });

  it('penyesuaian plus untuk bahan tanpa lot & tanpa masa simpan ditolak (lot default tidak dibuat)', async () => {
    await db.collection('products').insertOne({
      id: 'garam', tenantId: TID, kode: 'GARAM', nama: 'Garam', satuan: 'KG', itemRole: 'INGREDIENT', aktif: true,
      syncSource: 'local', gudangKode: 'GKERING', hargaBeli: 5000, stok: 0,
    });
    await db.collection('product_uom').insertOne({
      id: 'u-garam', tenantId: TID, productId: 'garam', satuan: 'KG', isBase: true, factorToBase: 1, aktif: true, sortOrder: 0,
    });
    const adj = (who: AuthContext, method: string, path: string[], body: Record<string, unknown> = {}) => (
      call(handlePenyesuaian as Handler, who, method, ['stok', 'penyesuaian', ...path], body)
    );
    const draft = await adj(GUDANG, 'POST', [], { items: [{ stokId: 'garam' }] });
    const id = String(draft.json.id);
    await adj(GUDANG, 'PUT', [id], { reasonCode: 'OPNAME', items: [{ stokId: 'garam', qtyAktual: 2 }] });
    await adj(GUDANG, 'POST', [id, 'submit']);
    const approve = await adj(SPV, 'POST', [id, 'approve']);
    expect(approve.status).not.toBe(200);
    expect(JSON.stringify(approve.json)).toMatch(/masa simpan/i);
    expect(await stockOf('garam')).toBe(0);
    expect(await db.collection('ingredient_lots').countDocuments({ tenantId: TID, productId: 'garam' })).toBe(0);
  });

  it('resep mode ketat: bahan berkonversi valid tersimpan, bahan kemasan tanpa konversi ditolak', async () => {
    const ok = await call(handleRecipes as Handler, ADMIN, 'PUT', ['recipes', 'rcp-nasi'], {
      nama: 'Nasi', yieldQty: 1, kategoriMenu: 'LAUK_NABATI',
      lines: [{ productId: 'beras', qtyBesar: 1000, pctKecil: 100, satuan: 'GR' }],
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const res = await call(handleRecipes as Handler, ADMIN, 'POST', ['recipes'], {
      nama: 'Sup Kaldu', yieldQty: 100, kategoriMenu: 'LAUK_NABATI',
      lines: [{ productId: 'kaldu', qtyBesar: 25, pctKecil: 100, satuan: 'GR' }],
    });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('RECIPE_CONVERSION_INVALID');
  });

  it('rekonsiliasi semua job: tanpa selisih dan tanpa error', async () => {
    for (const job of RECON_JOBS) {
      const r = await runReconForTenant(db, TID, job);
      expect(r.status, `${job}: ${JSON.stringify(r.summary)}`).toBe('OK');
      expect(r.totalMismatch, `${job}: ${JSON.stringify(r.findings)}`).toBe(0);
    }
  });
});
