/**
 * Fase 2.3 — gabung kode produk ganda (migrasi 0003) pada Mongo replica set: klasifikasi grup,
 * keputusan manual, pemindahan stok/lot/kartu/resep/dokumen persediaan, sumber vendor mergedInto,
 * guard posting, resolve item persediaan, dan index unik kode aktif.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { mergeDuplicateProductsMigration } from '@/lib/migrations/0003-merge-duplicate-products';
import { postStockMovements } from '@/lib/stock-ledger';
import { upsertProductFromVendor } from '@/lib/api/product-sync';
import { bulkUpsertProductsFromVendor } from '@/lib/api/product-sync-batch';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';
import { loadPlanReference } from '@/lib/food-production/plan-reference';
import {
  PRODUCT_KODE_UNIQUE_INDEX,
  countActiveDuplicateKode,
  findKodeCanonical,
  loadPurchaseSources,
  resolveStockProducts,
} from '@/lib/api/product-merge';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-23';
type Json = Record<string, unknown>;
type GroupRow = { kode: string; status: string; canonicalId: string | null; canonicalBy: string | null; reason?: string; recipes: Json[] };

const vendorProduct = (id: string, kode: string, vendor: string, extra: Json = {}) => ({
  id, tenantId: TID, kode, nama: `Produk ${kode}`, satuan: 'KG', itemRole: 'INGREDIENT', aktif: true,
  syncSource: 'sales.app', vendorTenantId: vendor, vendorTenantName: `Vendor ${vendor}`, vendorStokId: `vs-${id}`,
  vendorAktif: true, gudangKode: 'GKERING', hargaBeli: 10000, vendorHargaBeli: 10000, stok: 0,
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  ...extra,
});

describe.skipIf(!MongoMemoryReplSet)('Fase 2.3 gabung kode produk ganda (Mongo replica set)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;
  const now = new Date('2026-09-25T03:00:00Z');
  const ctx = () => ({ db, tenantId: TID, now, actor: 'it' });
  const groups = (report: { after: unknown }) => (report.after as { groups: GroupRow[] }).groups;
  const group = (report: { after: unknown }, kode: string) => groups(report).find((g) => g.kode === kode)!;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('merge_dup_it');
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });
    await db.collection('recipe_revisions').createIndexes([
      { key: { tenantId: 1, recipeId: 1, revision: 1 }, name: 'uniq_recipe_revisions_recipe_rev', unique: true },
      { key: { tenantId: 1, id: 1 }, name: 'uniq_recipe_revisions_id', unique: true },
    ]);
    await db.collection('recipe_portion_exceptions').createIndex({ tenantId: 1, productId: 1 }, { unique: true, name: 'uniq_rpe_tenant_product' });

    await db.collection('products').insertMany([
      // BR01: dua vendor, keduanya punya aktivitas → butuh keputusan.
      vendorProduct('beras-a', 'BR01', 'v1', { hargaBeli: 12000, vendorHargaBeli: 12000, stok: 10 }),
      vendorProduct('beras-b', 'BR01', 'v2', { hargaBeli: 15000, vendorHargaBeli: 15000, stok: 5 }),
      // MY01: satuan dasar beda → diblokir.
      vendorProduct('minyak-a', 'MY01', 'v1', { satuan: 'LITER' }),
      vendorProduct('minyak-b', 'MY01', 'v2', { satuan: 'ML' }),
      // GL01: tanpa aktivitas → kanonik default (aktif dulu).
      vendorProduct('gula-a', 'GL01', 'v1', { aktif: false, vendorAktif: false, createdAt: new Date('2025-01-01') }),
      vendorProduct('gula-b', 'GL01', 'v2', { vendorHargaBeli: 9000 }),
      // TL01: stok sumber di gudang lain → diblokir.
      vendorProduct('telur-a', 'TL01', 'v1'),
      vendorProduct('telur-b', 'TL01', 'v2', { gudangKode: 'GBASAH' }),
    ]);
    await db.collection('product_uom').insertMany([
      { id: 'u-a-kg', tenantId: TID, productId: 'beras-a', satuan: 'KG', isBase: true, factorToBase: 1, aktif: true, sortOrder: 0 },
      { id: 'u-a-sak', tenantId: TID, productId: 'beras-a', satuan: 'SAK', isBase: false, factorToBase: 25, aktif: true, sortOrder: 1 },
      { id: 'u-b-kg', tenantId: TID, productId: 'beras-b', satuan: 'KG', isBase: true, factorToBase: 1, aktif: true, sortOrder: 0 },
      { id: 'u-b-sak', tenantId: TID, productId: 'beras-b', satuan: 'SAK', isBase: false, factorToBase: 25, aktif: true, sortOrder: 1 },
      { id: 'u-b-karung', tenantId: TID, productId: 'beras-b', satuan: 'KARUNG', isBase: false, factorToBase: 50, aktif: true, sortOrder: 2 },
    ]);
    await db.collection('stok_lokasi').insertMany([
      { tenantId: TID, stokId: 'beras-a', lokasiKode: 'GKERING', qty: 10, qtyReserved: 1 },
      { tenantId: TID, stokId: 'beras-b', lokasiKode: 'GKERING', qty: 5, qtyReserved: 2 },
      { tenantId: TID, stokId: 'telur-b', lokasiKode: 'GBASAH', qty: 3 },
    ]);
    await db.collection('ingredient_lots').insertMany([
      { id: 'lot-b1', tenantId: TID, productId: 'beras-b', warehouseKode: 'GKERING', qtyRemaining: 5, qtyReceived: 5 },
    ]);
    await db.collection('stok_kartu').insertMany([
      { tenantId: TID, stokId: 'beras-a', sourceType: 'GRN', sourceId: 'grn-1', lineRef: '1', qty: 10, lokasiKode: 'GKERING' },
      { tenantId: TID, stokId: 'beras-b', sourceType: 'GRN', sourceId: 'grn-2', lineRef: '1', qty: 5, uomId: 'u-b-sak', lokasiKode: 'GKERING' },
      { tenantId: TID, stokId: 'telur-a', sourceType: 'GRN', sourceId: 'grn-3', lineRef: '1', qty: 0, lokasiKode: 'GKERING' },
    ]);
    await db.collection('recipes').insertOne({
      id: 'rcp-nasi', tenantId: TID, kode: 'RSP-NASI', nama: 'Nasi', version: 1, aktif: true, yieldQty: 100,
      updatedAt: new Date('2026-02-01'),
      lines: [
        { productId: 'beras-a', productKode: 'BR01', qtyBesar: 6000, pctKecil: 100, satuan: 'GR', qtyBaseBesar: 6, qtyBaseKecil: 6, factorToBase: 0.001, baseSatuan: 'KG', factorSource: 'SI' },
        { productId: 'beras-b', productKode: 'BR01', qtyBesar: 4000, pctKecil: 100, satuan: 'GR', qtyBaseBesar: 4, qtyBaseKecil: 4, factorToBase: 0.001, baseSatuan: 'KG', factorSource: 'SI' },
      ],
    });
    await db.collection('recipe_portion_exceptions').insertMany([
      { tenantId: TID, productId: 'beras-a', mode: 'KECIL_ONLY' },
      { tenantId: TID, productId: 'beras-b', mode: 'BESAR_ONLY' },
    ]);
    await db.collection('supplier_price_book').insertMany([
      { id: 'spb-a', tenantId: TID, supplierId: 'sup1', productId: 'beras-a', aktif: true, effectiveFrom: '2026-01-01', harga: 12000 },
      { id: 'spb-b', tenantId: TID, supplierId: 'sup1', productId: 'beras-b', aktif: true, effectiveFrom: '2026-03-01', harga: 15000 },
    ]);
    await db.collection('production_plans').insertOne({
      id: 'plan-1', tenantId: TID, noDokumen: 'RPN-1',
      materialOverrides: [
        { recipeId: 'rcp-nasi', productId: 'beras-a', qty: 7 },
        { recipeId: 'rcp-nasi', productId: 'beras-b', qty: 3 },
      ],
    });
    await db.collection('material_issues').insertOne({
      id: 'mi-1', tenantId: TID, noDokumen: 'MI-1',
      lines: [{ productId: 'beras-b', productIds: ['beras-b', 'beras-a'], qtyPlanned: 4, uomId: 'u-b-sak' }],
      fefoConsume: [{ stokId: 'beras-b', allocated: 4, shortfall: 0, allocations: [] }],
    });
    await db.collection('inventory_releases').insertOne({
      id: 'rl-1', tenantId: TID, noRelease: 'RL-1',
      items: [{ stokId: 'beras-b', qty: 1, qtyBase: 25, uomId: 'u-b-sak' }, { stokId: 'beras-b', qty: 1, qtyBase: 50, uomId: 'u-b-karung' }],
    });
    await db.collection('customer_purchase_orders').insertOne({
      id: 'cpo-1', tenantId: TID, noPO: 'PO-1', items: [{ localStokId: 'beras-b', qty: 5 }],
    });
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('dry-run: klasifikasi grup tanpa menulis data', async () => {
    const dry = await mergeDuplicateProductsMigration.run({ ...ctx(), dryRun: true });
    expect(dry.changed).toBe(0);
    expect(dry.before).toMatchObject({ duplicateKodeGroups: 4, activeDuplicateKode: 3 });
    expect(group(dry, 'BR01')).toMatchObject({ status: 'NEEDS_DECISION' });
    expect(group(dry, 'MY01')).toMatchObject({ status: 'BLOCKED_SATUAN' });
    expect(group(dry, 'GL01')).toMatchObject({ status: 'READY', canonicalId: 'gula-b', canonicalBy: 'DEFAULT' });
    expect(group(dry, 'TL01')).toMatchObject({ status: 'NEEDS_DECISION' });
    expect((dry.after as { decisionTemplate: Json }).decisionTemplate).toEqual({ BR01: 'beras-a | beras-b', TL01: 'telur-a | telur-b' });
    expect(await db.collection('products').countDocuments({ tenantId: TID, mergedInto: { $type: 'string' } })).toBe(0);
    expect(await db.collection('stok_lokasi').countDocuments({ tenantId: TID, stokId: 'beras-b' })).toBe(1);
  });

  it('keputusan yang bukan anggota grup ditolak', async () => {
    const dry = await mergeDuplicateProductsMigration.run({ ...ctx(), dryRun: true, options: { decisions: { BR01: 'gula-a' } } });
    expect(group(dry, 'BR01')).toMatchObject({ status: 'DECISION_INVALID' });
  });

  it('apply dengan keputusan: stok, lot, kartu, resep, dokumen persediaan pindah ke item kanonik', async () => {
    const res = await mergeDuplicateProductsMigration.run({
      ...ctx(), dryRun: false,
      options: { decisions: [{ kode: 'BR01', canonicalId: 'beras-a' }, { kode: 'TL01', canonicalId: 'telur-a' }] },
    });
    expect(group(res, 'BR01')).toMatchObject({ status: 'MERGED', canonicalId: 'beras-a', canonicalBy: 'DECISION' });
    expect(group(res, 'GL01')).toMatchObject({ status: 'MERGED', canonicalId: 'gula-b' });
    expect(group(res, 'MY01').status).toBe('BLOCKED_SATUAN');
    expect(group(res, 'TL01')).toMatchObject({ status: 'BLOCKED_GUDANG', canonicalId: 'telur-a', canonicalBy: 'DECISION' });
    expect(group(res, 'TL01').reason).toMatch(/GBASAH/);
    expect(res.after).toMatchObject({ activeDuplicateKode: 2, uniqueIndex: { created: false } });

    const lokasi = await db.collection('stok_lokasi').find({ tenantId: TID, stokId: { $in: ['beras-a', 'beras-b'] } }).toArray();
    expect(lokasi).toHaveLength(1);
    expect(lokasi[0]).toMatchObject({ stokId: 'beras-a', qty: 15, qtyReserved: 3 });
    const [a, b] = await Promise.all(['beras-a', 'beras-b'].map((id) => db.collection('products').findOne({ id })));
    expect(a).toMatchObject({ stok: 15, hargaBeli: 13000, aktif: true });
    expect(a!.mergedInto ?? null).toBeNull();
    expect(b).toMatchObject({ mergedInto: 'beras-a', mergeSource: 'MIGRATION_0003', vendorStokId: 'vs-beras-b', vendorHargaBeli: 15000, stok: 0 });

    expect(await db.collection('ingredient_lots').findOne({ id: 'lot-b1' })).toMatchObject({ productId: 'beras-a', mergedFromProductId: 'beras-b' });
    const kartuB = await db.collection('stok_kartu').findOne({ sourceId: 'grn-2' });
    expect(kartuB).toMatchObject({ stokId: 'beras-a', mergedFromStokId: 'beras-b', uomId: 'u-a-sak', sourceType: 'GRN', lineRef: '1' });

    const recipe = await db.collection('recipes').findOne({ id: 'rcp-nasi' });
    expect(recipe!.lines).toHaveLength(1);
    expect(recipe!.lines[0]).toMatchObject({ productId: 'beras-a', qtyBesar: 10000, qtyBaseBesar: 10 });
    const revs = await db.collection('recipe_revisions').find({ recipeId: 'rcp-nasi' }).sort({ revision: 1 }).toArray();
    expect(revs.map((r) => r.reason)).toEqual(['BACKFILL', 'PRODUCT_MERGE']);

    const rpe = await db.collection('recipe_portion_exceptions').find({ tenantId: TID }).toArray();
    expect(rpe.map((r) => [r.productId, r.mode])).toEqual([['beras-a', 'KECIL_ONLY']]);
    const spb = await db.collection('supplier_price_book').find({ tenantId: TID }).sort({ id: 1 }).toArray();
    expect(spb.map((r) => [r.id, r.productId, r.aktif])).toEqual([['spb-a', 'beras-a', false], ['spb-b', 'beras-a', true]]);
    const plan = await db.collection('production_plans').findOne({ id: 'plan-1' });
    expect(plan!.materialOverrides).toEqual([{ recipeId: 'rcp-nasi', productId: 'beras-a', qty: 7 }]);

    const mi = await db.collection('material_issues').findOne({ id: 'mi-1' });
    expect(mi!.lines[0]).toMatchObject({ productId: 'beras-a', productIds: ['beras-a', 'beras-a'], uomId: 'u-a-sak' });
    expect(mi!.fefoConsume[0].stokId).toBe('beras-a');
    const rl = await db.collection('inventory_releases').findOne({ id: 'rl-1' });
    expect(rl!.items.map((i: Json) => [i.stokId, i.uomId])).toEqual([['beras-a', 'u-a-sak'], ['beras-a', 'u-b-karung']]);
    // Dokumen pembelian ke vendor tetap memakai salinan vendor.
    expect((await db.collection('customer_purchase_orders').findOne({ id: 'cpo-1' }))!.items[0].localStokId).toBe('beras-b');

    const audit = await db.collection('audit_log').findOne({ tenantId: TID, action: 'PRODUCT_MERGE', entityType: 'product', entityId: 'beras-a' });
    expect(audit?.metadata).toMatchObject({ kode: 'BR01', canonicalBy: 'DECISION' });
    expect((await db.collection('products').findOne({ id: 'gula-a' }))).toMatchObject({ mergedInto: 'gula-b' });
  });

  it('posting stok ke salinan yang sudah digabung ditolak', async () => {
    const res = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'PENYESUAIAN', sourceId: 'adj-merged', noTransaksi: 'ADJ-M', keterangan: 'x',
      lines: [{ lineRef: '1', productId: 'beras-b', warehouseKode: 'GKERING', deltaQtyBase: 1, binPolicy: 'NONE' }],
    } as never);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/sudah digabung/);
  });

  it('GRN dengan baris salinan vendor: stok, lot, kartu, harga rata-rata masuk item kanonik', async () => {
    const grn = {
      id: 'grn-merged', tenantId: TID, noGRN: 'GRN-M1', noDO: 'DO-M1', vendorTenantId: 'v2',
      items: [{ lineId: 'l1', localStokId: 'beras-b', vendorKode: 'BR01', qtyOrdered: 2, qtyBase: 50, uomId: 'u-b-sak', satuan: 'SAK', harga: 300000 }],
    };
    const res = await applyGrnStockPosting(db, TID, grn as never, [], undefined, { userId: 'u1', userName: 'Tester' } as never);
    expect(res.error).toBeUndefined();
    expect(res.itemsFull![0]).toMatchObject({ localStokId: 'beras-b', stockProductId: 'beras-a', qtyReceivedBase: 50 });
    expect(await db.collection('stok_lokasi').findOne({ tenantId: TID, stokId: 'beras-a', lokasiKode: 'GKERING' })).toMatchObject({ qty: 65 });
    expect(await db.collection('stok_lokasi').countDocuments({ tenantId: TID, stokId: 'beras-b' })).toBe(0);
    const kartu = await db.collection('stok_kartu').findOne({ sourceId: 'grn-merged' });
    expect(kartu).toMatchObject({ stokId: 'beras-a', uomId: 'u-a-sak' });
    expect(await db.collection('ingredient_lots').findOne({ grnId: 'grn-merged' })).toMatchObject({ productId: 'beras-a' });
    // (15 × 13.000 + 50 × 12.000) / 65
    expect(await db.collection('products').findOne({ id: 'beras-a' })).toMatchObject({ stok: 65, hargaBeli: 12231 });
  });

  it('acuan rencana: qty PO salinan vendor dikonversi dengan kemasan vendornya dan jatuh di baris item kanonik', async () => {
    const plan = { id: 'plan-m', tenantId: TID, tanggal: '2026-09-25', kitchenId: 'k1' };
    await db.collection('customer_purchase_orders').insertOne({
      id: 'po-m', tenantId: TID, noPO: 'CPO-M', productionPlanId: 'plan-m', status: 'RECEIVED', createdAt: new Date(),
      items: [{ localStokId: 'beras-b', kode: 'BR01', satuan: 'KARUNG', uomId: 'u-b-karung', qty: 2, qtyReceived: 1 }],
    });
    await db.collection('inventory_releases').insertOne({
      id: 'rl-m', tenantId: TID, noRelease: 'RL-M', productionPlanId: 'plan-m', status: 'POSTED',
      items: [{ stokId: 'beras-a', qty: 20, qtyBase: 20, satuan: 'KG' }],
    });
    const ref = await loadPlanReference(db, { tenantId: TID, role: 'ADMIN' } as never, plan);
    const rows = ref.lines.filter((l) => l.productKode === 'BR01');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ productId: 'beras-a', poQtyOrdered: 100, poQtyReceived: 50, rlPosted: 20 });
    expect(rows[0].warnings || []).toEqual([]);
  });

  it('resolve item persediaan: salinan vendor → kanonik; sumber pembelian = vendor aktif termurah', async () => {
    const resolved = await resolveStockProducts(db, TID, ['beras-b', 'beras-a']);
    expect('error' in resolved).toBe(false);
    if ('error' in resolved) return;
    expect(resolved.targets.get('beras-b')).toMatchObject({ productId: 'beras-a', merged: true });
    expect(resolved.targets.get('beras-a')).toMatchObject({ productId: 'beras-a', merged: false });
    expect((await findKodeCanonical(db, TID, 'BR01'))?.id).toBe('beras-a');

    const sources = await loadPurchaseSources(db, TID, [await db.collection('products').findOne({ id: 'beras-a' }) as never]);
    expect(sources.get('beras-a')?.id).toBe('beras-a');
  });

  it('perbaikan master lalu jalankan ulang: sisa grup digabung, index unik kode aktif dibuat', async () => {
    await db.collection('products').updateOne({ id: 'minyak-b' }, { $set: { satuan: 'LITER' } });
    await db.collection('stok_lokasi').deleteOne({ stokId: 'telur-b' });
    const res = await mergeDuplicateProductsMigration.run({ ...ctx(), dryRun: false });
    expect(group(res, 'MY01').status).toBe('MERGED');
    expect(group(res, 'TL01').status).toBe('MERGED');
    expect(res.after).toMatchObject({ activeDuplicateKode: 0, uniqueIndex: { created: true } });
    expect(await countActiveDuplicateKode(db, TID)).toBe(0);
    const idx = await db.collection('products').indexes();
    expect(idx.find((i) => i.name === PRODUCT_KODE_UNIQUE_INDEX)).toMatchObject({ unique: true });

    await expect(db.collection('products').insertOne(vendorProduct('beras-c', 'BR01', 'v3'))).rejects.toMatchObject({ code: 11000 });
    await db.collection('products').insertOne(vendorProduct('beras-d', 'BR01', 'v4', { mergedInto: 'beras-a' }));

    const again = await mergeDuplicateProductsMigration.run({ ...ctx(), dryRun: false });
    expect(again.before).toMatchObject({ duplicateKodeGroups: 0 });
    expect(again.changed).toBe(0);
  });

  const vendorPayload = (vendorStokId: string, kode: string, vendor: string, extra: Json = {}) => ({
    id: vendorStokId, kode, nama: `Produk ${kode}`, satuan: 'KG', aktif: true, vendorTenantId: vendor,
    vendorTenantName: `Vendor ${vendor}`, hargaBeli: 11000, hargaEcer: 13000, grup: 'Bahan', ...extra,
  });

  it('sync vendor baru untuk kode yang sudah punya item → otomatis jadi sumber vendor', async () => {
    const res = await upsertProductFromVendor(db, TID, 'v5', vendorPayload('vs-new5', 'BR01', 'v5'));
    expect(res.action).toBe('created');
    const doc = await db.collection('products').findOne({ id: res.id });
    expect(doc).toMatchObject({ mergedInto: 'beras-a', mergeSource: 'SYNC_AUTO', vendorAktif: true, stok: 0 });

    const batch = await bulkUpsertProductsFromVendor(db, TID, [
      vendorPayload('vs-new6', 'GL01', 'v6'),
      vendorPayload('vs-new7', 'KD99', 'v7'),
      vendorPayload('vs-new8', 'KD99', 'v8'),
    ]);
    expect(batch).toMatchObject({ created: 3, errors: [] });
    const [gl, k7, k8] = await Promise.all(['vs-new6', 'vs-new7', 'vs-new8'].map((s) => db.collection('products').findOne({ vendorStokId: s })));
    expect(gl!.mergedInto).toBe('gula-b');
    expect(k7!.mergedInto ?? null).toBeNull();
    expect(k8!.mergedInto).toBe(k7!.id);
  });

  it('item kanonik tetap aktif selama ada sumber vendor aktif; ikut nonaktif bila semua vendor nonaktif', async () => {
    await upsertProductFromVendor(db, TID, 'v1', vendorPayload('vs-beras-a', 'BR01', 'v1', { aktif: false }));
    expect(await db.collection('products').findOne({ id: 'beras-a' })).toMatchObject({ aktif: true, vendorAktif: false });

    await db.collection('products').updateMany({ mergedInto: 'beras-a' }, { $set: { aktif: false, vendorAktif: false } });
    await upsertProductFromVendor(db, TID, 'v1', vendorPayload('vs-beras-a', 'BR01', 'v1', { aktif: false, hargaBeli: 11500 }));
    expect(await db.collection('products').findOne({ id: 'beras-a' })).toMatchObject({ aktif: false, vendorAktif: false });

    await upsertProductFromVendor(db, TID, 'v1', vendorPayload('vs-beras-a', 'BR01', 'v1', { aktif: true }));
    expect(await db.collection('products').findOne({ id: 'beras-a' })).toMatchObject({ aktif: true, vendorAktif: true });
  });

  it('kode salinan tergabung diganti vendor → pindah ke item kanonik kode baru bila ada', async () => {
    const k8 = await db.collection('products').findOne({ vendorStokId: 'vs-new8' });
    await upsertProductFromVendor(db, TID, 'v8', vendorPayload('vs-new8', 'GL01', 'v8'));
    expect(await db.collection('products').findOne({ id: k8!.id })).toMatchObject({ kode: 'GL01', mergedInto: 'gula-b' });

    // Kode baru belum punya item: tetap di item lama (menunggu rename item kanonik).
    await upsertProductFromVendor(db, TID, 'v6', vendorPayload('vs-new6', 'GL02', 'v6'));
    expect(await db.collection('products').findOne({ vendorStokId: 'vs-new6' })).toMatchObject({ kode: 'GL02', mergedInto: 'gula-b' });
    const dry = await mergeDuplicateProductsMigration.run({ ...ctx(), dryRun: true });
    expect((dry.after as { mergedKodeMismatch: Json[] }).mergedKodeMismatch).toEqual([
      expect.objectContaining({ kode: 'GL02', canonicalKode: 'GL01', mergedInto: 'gula-b' }),
    ]);
  });

  it('bentrok kode item kanonik saat sync dilaporkan per item, item lain tetap tersimpan', async () => {
    const batch = await bulkUpsertProductsFromVendor(db, TID, [
      vendorPayload('vs-new7', 'BR01', 'v7'),
      vendorPayload('vs-new9', 'ZZ01', 'v9'),
    ]);
    expect(batch.errors).toEqual([expect.objectContaining({ kode: 'BR01', vendorTenantId: 'v7' })]);
    expect(batch.created).toBe(1);
    expect(await db.collection('products').findOne({ vendorStokId: 'vs-new7' })).toMatchObject({ kode: 'KD99' });
    expect(await db.collection('products').findOne({ vendorStokId: 'vs-new9' })).toBeTruthy();

    await expect(upsertProductFromVendor(db, TID, 'v7', vendorPayload('vs-new7', 'BR01', 'v7'))).rejects.toThrow(/BR01/);
  });
});
