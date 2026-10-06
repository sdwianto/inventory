/**
 * Migrasi 0011: Tahu PTG → BAK (÷32), Tempe PTG → ALIR (÷20). Fixture meniru data produksi:
 * GRN 85 BAK = 2720 PTG, RL 2720 PTG, lot/reservasi habis, MRP/PR lama, resep 500 PTG + revisi.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { rebaseProductUomMigration } from '@/lib/migrations/0011-rebase-product-uom';
import { resolveRecipeLineForExecution } from '@/lib/food-production/recipe-conversion';
import { recipeContentHash, recipeRevisionContent } from '@/lib/food-production/recipe-revision';
import type { RecipeLine } from '@/lib/food-production/recipe';
import { uomRebasePendingPatch } from '@/lib/api/uom-rebase-guard';
import { postStockMovements } from '@/lib/stock-ledger/post-stock-movements';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-rebase';
const TAHU = 'tahu-1';
const TEMPE = 'tempe-1';

function recipeLine(): RecipeLine {
  return {
    productId: TAHU, productKode: 'B509689', productNama: 'Tahu Putih',
    qty: 500, qtyBesar: 500, pctKecil: 70, qtyKecil: 350, satuan: 'PTG',
    qtyBaseBesar: 500, qtyBaseKecil: 350, factorToBase: 1, baseSatuan: 'PTG', factorSource: 'IDENTITY',
  };
}

async function seed(db: Db) {
  await db.collection('products').insertMany([
    {
      id: TAHU, tenantId: TID, kode: 'B509689', nama: 'Tahu Putih', satuan: 'PTG', baseUomId: 'u-tahu-ptg',
      stok: 0, minStok: 64, hargaBeli: 344, avgCost: 343.7521, vendorTenantId: 'uddawam',
    },
    { id: TEMPE, tenantId: TID, kode: 'B824159', nama: 'Tempe kecil', satuan: 'PTG', baseUomId: 'u-tempe-ptg', stok: 0, minStok: 0, hargaBeli: 0 },
    { id: TAHU, tenantId: 'other', kode: 'B509689', nama: 'Tahu Putih', satuan: 'PTG', stok: 0, hargaBeli: 344 },
  ]);
  await db.collection('product_uom').insertMany([
    { id: 'u-tahu-ptg', tenantId: TID, productId: TAHU, satuan: 'PTG', isBase: true, factorToBase: 1, aktif: true, hargaEcer: 345 },
    { id: 'u-tahu-bak', tenantId: TID, productId: TAHU, satuan: 'BAK', isBase: false, factorToBase: 32, aktif: true, hargaEcer: 11018 },
    { id: 'u-tempe-ptg', tenantId: TID, productId: TEMPE, satuan: 'PTG', isBase: true, factorToBase: 1, aktif: true },
    { id: 'u-tempe-alir', tenantId: TID, productId: TEMPE, satuan: 'ALIR', isBase: false, factorToBase: 20, aktif: true },
  ]);
  await db.collection('stok_lokasi').insertMany([
    { tenantId: TID, stokId: TAHU, lokasiKode: 'GBASAH', qty: 0, qtyReserved: 0 },
    { tenantId: TID, stokId: TEMPE, lokasiKode: 'GKERING', qty: 0, qtyReserved: 0 },
  ]);
  await db.collection('stok_kartu').insertMany([
    { id: 'k-in', tenantId: TID, stokId: TAHU, sourceType: 'GRN', masuk: 2720, keluar: 0, qtyEntered: 85, satuan: 'BAK', hargaSatuan: 344 },
    {
      id: 'k-out', tenantId: TID, stokId: TAHU, sourceType: 'RELEASE', masuk: 0, keluar: 2720, qtyEntered: 2720, satuan: 'PTG', hargaSatuan: 344,
      ingredientLotAllocations: [{ batchId: 'lot-1', qty: 2720 }], fefoAllocations: [],
    },
  ]);
  await db.collection('ingredient_lots').insertOne({ id: 'lot-1', tenantId: TID, productId: TAHU, qty: 2720, qtyRemaining: 0, satuan: 'PTG', satuanLegacy: 'BAK', status: 'CONSUMED' });
  await db.collection('stock_allocations').insertOne({ id: 'al-1', tenantId: TID, productId: TAHU, qty: 1440, qtyRemaining: 0, status: 'CONSUMED' });
  await db.collection('goods_receipts').insertOne({
    id: 'grn-1', tenantId: TID, noGRN: 'GRN1', status: 'POSTED',
    items: [
      { localStokId: TAHU, satuan: 'BAK', qtyBase: 2720, factorToBase: 32, qtyOrdered: 85, qtyReceived: 85, qtyReceivedBase: 2720, harga: 11000, hargaBeliBaru: 344 },
      { localStokId: 'lain', satuan: 'KG', qtyBase: 5, factorToBase: 1, qtyReceived: 5, qtyReceivedBase: 5 },
    ],
  });
  await db.collection('customer_purchase_orders').insertMany([
    {
      id: 'po-1', tenantId: TID, noPO: 'CPO1', status: 'INVOICED',
      items: [{ localStokId: TAHU, satuan: 'BAK', qty: 85, factorToBase: 32, estimasiHarga: 11000, hargaBeliReferensi: 344, qtyReceived: 85 }],
    },
    {
      id: 'po-draft', tenantId: TID, noPO: 'CPO66', status: 'DRAFT',
      items: [{ localStokId: TAHU, satuan: 'PTG', qty: 1259, uomId: 'u-tahu-ptg', estimasiHarga: 0 }],
    },
  ]);
  await db.collection('inventory_releases').insertOne({
    id: 'rl-1', tenantId: TID, noRelease: 'RL1', status: 'POSTED',
    items: [{ stokId: TAHU, satuan: 'PTG', qty: 2720, qtyBase: 2720, qtyEntered: 2720, hargaBeli: 344 }],
    ingredientLotConsume: [{ stokId: TAHU, needQty: 2720, allocated: 2720, shortfall: 0, allocations: [{ batchId: 'lot-1', qty: 2720 }] }],
  });
  await db.collection('material_requirements').insertOne({
    id: 'mrp-1', tenantId: TID, noDokumen: 'KBH1', status: 'APPROVED',
    lines: [
      {
        productId: TAHU, satuan: 'PTG', qtyGross: 2307, qtyOnHand: 0, qtyNet: 2307, shortage: true,
        sources: [{ recipeId: 'r-1', qty: 2306.6572 }],
      },
      { productId: 'lain', satuan: 'KG', qtyGross: 10, qtyOnHand: 0, qtyNet: 10, shortage: true, sources: [] },
    ],
    summary: { lineCount: 2, shortageCount: 2, qtyGrossTotal: 2317, qtyNetTotal: 2317 },
  });
  await db.collection('purchase_requirements').insertOne({
    id: 'pr-1', tenantId: TID, noDokumen: 'PRB1', status: 'DRAFT',
    lines: [{ productId: TAHU, satuan: 'PTG', qtyNet: 1134, qtyGross: 1390, qtyOnHand: 256 }],
  });
  await db.collection('material_issues').insertOne({
    id: 'pbl-1', tenantId: TID, noDokumen: 'PBL1', status: 'COMPLETED',
    lines: [{ productId: TAHU, satuan: 'PTG', qtyPlanned: 2307, qtyIssued: 0 }],
    summary: { lineCount: 1, qtyPlannedTotal: 2307, qtyIssuedTotal: 0 },
  });
  const line = recipeLine();
  const revContent = recipeRevisionContent({ kode: 'RSP-1', nama: 'Tahu Goreng', yieldQty: 500, lines: [line] });
  const revHash = recipeContentHash(revContent);
  await db.collection('recipe_revisions').insertOne({ ...revContent, id: 'rev-1', tenantId: TID, recipeId: 'r-1', revision: 1, contentHash: revHash });
  await db.collection('recipes').insertOne({
    id: 'r-1', tenantId: TID, kode: 'RSP-1', nama: 'Tahu Goreng', yieldQty: 500, lines: [line],
    currentRevisionId: 'rev-1', revision: 1, revisionHash: revHash,
  });
  await db.collection('supplier_price_book').insertOne({ id: 'spb-1', tenantId: TID, productId: TAHU, satuan: 'PTG', harga: 11000, aktif: true });
}

describe.skipIf(!MongoMemoryReplSet)('0011 rebase satuan dasar tempe/tahu (Mongo replica set)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;
  const now = new Date('2026-10-06T15:00:00Z');
  const run = (dryRun: boolean, options?: Record<string, unknown>) =>
    rebaseProductUomMigration.run({ db, tenantId: TID, now, dryRun, actor: 'it', options });

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('rebase_uom_it');
    await seed(db);
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('dry-run melaporkan PO DRAFT ber-PTG sebagai blocker tanpa menulis', async () => {
    const r = await run(true);
    expect(r.changed).toBe(0);
    const before = r.before as { blockers: string[]; counts: Record<string, number> };
    expect(before.blockers.join(' ')).toMatch(/CPO66/);
    expect(before.counts.stok_kartu).toBe(2);
    expect((await db.collection('products').findOne({ tenantId: TID, id: TAHU }))?.satuan).toBe('PTG');
  });

  it('apply ditolak selama ada blocker', async () => {
    await expect(run(false)).rejects.toThrow(/CPO66/);
    expect((await db.collection('stok_kartu').findOne({ id: 'k-in' }))?.masuk).toBe(2720);
  });

  it('apply mengonversi seluruh qty basis, biaya, UOM, resep; tenant lain utuh; idempoten', async () => {
    await db.collection('customer_purchase_orders').updateOne({ id: 'po-draft' }, { $set: { status: 'CANCELLED' } });
    const r = await run(false);
    expect(r.changed).toBeGreaterThan(10);

    const tahu = await db.collection('products').findOne({ tenantId: TID, id: TAHU });
    expect(tahu).toMatchObject({ satuan: 'BAK', baseUomId: 'u-tahu-bak', hargaBeli: 11008, minStok: 2, recipeCutEnabled: true });
    expect(tahu?.avgCost).toBeCloseTo(11000.0672, 4);
    expect(tahu?.uomRebase?.[0]).toMatchObject({ from: 'PTG', to: 'BAK', factor: 32 });
    const tempe = await db.collection('products').findOne({ tenantId: TID, id: TEMPE });
    expect(tempe).toMatchObject({ satuan: 'ALIR', baseUomId: 'u-tempe-alir', recipeCutEnabled: true });

    expect(await db.collection('product_uom').findOne({ id: 'u-tahu-bak' })).toMatchObject({ isBase: true, factorToBase: 1, aktif: true });
    expect(await db.collection('product_uom').findOne({ id: 'u-tahu-ptg' })).toMatchObject({ isBase: false, aktif: false });

    expect(await db.collection('stok_kartu').findOne({ id: 'k-in' })).toMatchObject({ masuk: 85, hargaSatuan: 11008, qtyEntered: 85, satuan: 'BAK' });
    const out = await db.collection('stok_kartu').findOne({ id: 'k-out' });
    expect(out).toMatchObject({ keluar: 85, qtyEntered: 2720, satuan: 'PTG' });
    expect(out?.ingredientLotAllocations[0].qty).toBe(85);
    expect(await db.collection('ingredient_lots').findOne({ id: 'lot-1' })).toMatchObject({ qty: 85, qtyRemaining: 0, satuan: 'BAK', satuanLegacy: 'BAK' });
    expect((await db.collection('stock_allocations').findOne({ id: 'al-1' }))?.qty).toBe(45);

    const grn = await db.collection('goods_receipts').findOne({ id: 'grn-1' });
    expect(grn?.items[0]).toMatchObject({ qtyBase: 85, qtyReceivedBase: 85, factorToBase: 1, qtyReceived: 85, harga: 11000, hargaBeliBaru: 11008 });
    expect(grn?.items[1]).toMatchObject({ qtyBase: 5, factorToBase: 1 });
    const po = await db.collection('customer_purchase_orders').findOne({ id: 'po-1' });
    expect(po?.items[0]).toMatchObject({ qty: 85, factorToBase: 1, hargaBeliReferensi: 11008, estimasiHarga: 11000 });
    const rl = await db.collection('inventory_releases').findOne({ id: 'rl-1' });
    expect(rl?.items[0]).toMatchObject({ qtyBase: 85, qty: 2720, satuan: 'PTG', hargaBeli: 11008 });
    expect(rl?.ingredientLotConsume[0]).toMatchObject({ needQty: 85, allocated: 85 });
    expect(rl?.ingredientLotConsume[0].allocations[0].qty).toBe(85);

    const mrp = await db.collection('material_requirements').findOne({ id: 'mrp-1' });
    // 2306,6572 PTG / 32 = 72,08 BAK → pengadaan 73 BAK
    expect(mrp?.lines[0]).toMatchObject({ satuan: 'BAK', qtyGross: 73, qtyNet: 73 });
    expect(mrp?.lines[0].sources[0].qty).toBeCloseTo(72.083, 3);
    expect(mrp?.lines[1]).toMatchObject({ satuan: 'KG', qtyGross: 10 });
    expect(mrp?.summary).toMatchObject({ qtyGrossTotal: 83, qtyNetTotal: 83 });
    const pr = await db.collection('purchase_requirements').findOne({ id: 'pr-1' });
    expect(pr?.lines[0]).toMatchObject({ satuan: 'BAK', qtyNet: 36, qtyGross: 44, qtyOnHand: 8 });
    const pbl = await db.collection('material_issues').findOne({ id: 'pbl-1' });
    expect(pbl?.lines[0]).toMatchObject({ satuan: 'BAK', qtyPlanned: 72.09375 });

    const recipe = await db.collection('recipes').findOne({ id: 'r-1' });
    expect(recipe?.lines[0]).toMatchObject({
      satuan: 'POTONG', potongPerBase: 32, qtyBesar: 500, qtyKecil: 350, qtyBaseBesar: 15.625, qtyBaseKecil: 10.9375, baseSatuan: 'BAK', factorSource: 'CUT',
    });
    const rev = await db.collection('recipe_revisions').findOne({ id: 'rev-1' });
    expect(rev?.lines[0]).toMatchObject({ satuan: 'POTONG', baseSatuan: 'BAK', qtyBaseBesar: 15.625 });
    expect(rev?.contentHash).toBe(recipeContentHash(recipeRevisionContent(rev as never)));
    expect(recipe?.revisionHash).toBe(rev?.contentHash);

    const exec = resolveRecipeLineForExecution(recipe?.lines[0] as RecipeLine, tahu as never, { strict: true });
    expect(exec.error).toBeUndefined();
    expect(exec.line.qtyBaseBesar).toBe(15.625);

    expect((await db.collection('supplier_price_book').findOne({ id: 'spb-1' }))).toMatchObject({ satuan: 'BAK', harga: 11000 });
    expect(await db.collection('products').findOne({ tenantId: 'other', id: TAHU })).toMatchObject({ satuan: 'PTG', hargaBeli: 344 });
    expect(await db.collection('audit_log').countDocuments({ tenantId: TID, action: 'PRODUCT_UOM_REBASE' })).toBe(1);

    const again = await run(false);
    expect(again.changed).toBe(0);
    expect((await db.collection('stok_kartu').findOne({ id: 'k-in' }))?.masuk).toBe(85);
  });

  it('setelah sync sales.app (basis sudah BAK): data lama tetap dikonversi, mutasi baru menolak', async () => {
    const T2 = 'it-rebase-synced';
    await db.collection('products').insertOne({ id: 'tahu-2', tenantId: T2, kode: 'B509689', satuan: 'BAK', baseUomId: 'u2-bak', stok: 0, hargaBeli: 344 });
    await db.collection('product_uom').insertOne({ id: 'u2-bak', tenantId: T2, productId: 'tahu-2', satuan: 'BAK', isBase: true, factorToBase: 1, aktif: true });
    await db.collection('stok_kartu').insertOne({ id: 'k2-old', tenantId: T2, stokId: 'tahu-2', masuk: 2720, keluar: 0, qtyEntered: 85, satuan: 'BAK', hargaSatuan: 344 });
    const go = (dryRun: boolean) => rebaseProductUomMigration.run({ db, tenantId: T2, now, dryRun, actor: 'it' });

    const ok = await go(false);
    expect(ok.changed).toBeGreaterThan(0);
    expect((await db.collection('stok_kartu').findOne({ id: 'k2-old' }))?.masuk).toBe(85);
    expect((await db.collection('products').findOne({ id: 'tahu-2' }))?.hargaBeli).toBe(11008);

    const T3 = 'it-rebase-new-era';
    await db.collection('products').insertOne({ id: 'tahu-3', tenantId: T3, kode: 'B509689', satuan: 'BAK', stok: 10 });
    await db.collection('product_uom').insertOne({ id: 'u3-bak', tenantId: T3, productId: 'tahu-3', satuan: 'BAK', isBase: true, factorToBase: 1, aktif: true });
    await db.collection('stok_kartu').insertOne({ id: 'k3-new', tenantId: T3, stokId: 'tahu-3', masuk: 10, keluar: 0, qtyEntered: 10, satuan: 'BAK' });
    const dry = await rebaseProductUomMigration.run({ db, tenantId: T3, now, dryRun: true, actor: 'it' });
    expect((dry.before as { blockers: string[] }).blockers.join(' ')).toMatch(/setelah sync/);
  });

  it('sync basis berubah menandai produk berriwayat, posting stok ditolak, migrasi menghapus tanda', async () => {
    const T5 = 'it-rebase-guard';
    const existing = { id: 'tahu-5', tenantId: T5, kode: 'B509689', satuan: 'PTG', stok: 0, hargaBeli: 344, gudangKode: 'GBASAH' };
    await db.collection('products').insertMany([existing, { id: 'baru-5', tenantId: T5, kode: 'X', satuan: 'PTG' }]);
    await db.collection('stok_kartu').insertOne({ id: 'k5', tenantId: T5, stokId: 'tahu-5', masuk: 32, keluar: 0, qtyEntered: 32, satuan: 'PTG', hargaSatuan: 344 });

    expect(await uomRebasePendingPatch(db, T5, { id: 'baru-5', satuan: 'PTG' }, 'BAK', now)).toBeNull();
    expect(await uomRebasePendingPatch(db, T5, existing, 'PTG', now)).toBeNull();
    const patch = await uomRebasePendingPatch(db, T5, existing, 'BAK', now);
    expect(patch?.uomRebasePending).toMatchObject({ from: 'PTG', to: 'BAK' });

    // simulasi hasil sync sales.app
    await db.collection('products').updateOne({ id: 'tahu-5' }, { $set: { satuan: 'BAK', baseUomId: 'u5-bak', ...patch } });
    await db.collection('product_uom').insertOne({ id: 'u5-bak', tenantId: T5, productId: 'tahu-5', satuan: 'BAK', isBase: true, factorToBase: 1, aktif: true });
    await db.collection('stok_lokasi').insertOne({ tenantId: T5, stokId: 'tahu-5', lokasiKode: 'GBASAH', qty: 32, qtyReserved: 0 });

    const posted = await postStockMovements(db, undefined, {
      tenantId: T5, sourceType: 'ADJUSTMENT', sourceId: 'adj-5', noTransaksi: 'ADJ5', keterangan: 'uji',
      lines: [{ lineRef: 'l1', productId: 'tahu-5', warehouseKode: 'GBASAH', deltaQtyBase: 1 }],
    });
    expect(posted.ok).toBe(false);
    expect(!posted.ok && posted.error).toMatch(/0011-rebase-product-uom/);

    const r = await rebaseProductUomMigration.run({ db, tenantId: T5, now, dryRun: false, actor: 'it' });
    expect(r.changed).toBeGreaterThan(0);
    const after = await db.collection('products').findOne({ id: 'tahu-5' });
    expect(after?.uomRebasePending).toBeUndefined();
    expect(after?.stok).toBe(1);
    expect((await db.collection('stok_lokasi').findOne({ tenantId: T5, stokId: 'tahu-5' }))?.qty).toBe(1);
    expect((await db.collection('stok_kartu').findOne({ id: 'k5' }))?.masuk).toBe(1);
  });

  it('stok yang tidak habis dibagi faktor diblokir', async () => {
    const T4 = 'it-rebase-dust';
    await db.collection('products').insertOne({ id: 'tahu-4', tenantId: T4, kode: 'B509689', satuan: 'PTG', stok: 5 });
    await db.collection('product_uom').insertMany([
      { id: 'u4-ptg', tenantId: T4, productId: 'tahu-4', satuan: 'PTG', isBase: true, factorToBase: 1, aktif: true },
      { id: 'u4-bak', tenantId: T4, productId: 'tahu-4', satuan: 'BAK', isBase: false, factorToBase: 32, aktif: true },
    ]);
    await db.collection('stok_lokasi').insertOne({ tenantId: T4, stokId: 'tahu-4', lokasiKode: 'G', qty: 5, qtyReserved: 0 });
    const dry = await rebaseProductUomMigration.run({ db, tenantId: T4, now, dryRun: true, actor: 'it' });
    expect((dry.before as { blockers: string[] }).blockers.join(' ')).toMatch(/tidak habis dibagi 32/);
  });
});
