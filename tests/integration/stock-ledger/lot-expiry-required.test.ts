/**
 * Fase 3.1 — kedaluwarsa & no. lot pemasok di GRN (flag tenant lotExpiryRequired) dan lot baru
 * dari penyesuaian (masa simpan master atau ditolak), pada Mongo replica set.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { postStockMovements } from '@/lib/stock-ledger';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';
import { enrichGrnDocWithProducts } from '@/lib/api/grn-enrich';
import { addShelfDays, businessDateIso } from '@/lib/food-production/ingredient-lot';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-31';
type Json = Record<string, unknown>;

const product = (id: string, extra: Json = {}) => ({
  id, tenantId: TID, kode: id.toUpperCase(), nama: `Produk ${id}`, satuan: 'KG', itemRole: 'INGREDIENT', aktif: true,
  syncSource: 'local', gudangKode: 'GKERING', hargaBeli: 10000, stok: 0,
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  ...extra,
});

const actor = { userId: 'u1', userName: 'Tester' } as never;

let grnSeq = 0;
const grnOf = (lines: Array<{ stokId: string; qty?: number }>) => {
  grnSeq += 1;
  return {
    id: `grn-${grnSeq}`, tenantId: TID, noGRN: `GRN-31-${grnSeq}`, noDO: `DO-31-${grnSeq}`, vendorTenantId: 'v1',
    items: lines.map((l, i) => ({
      lineId: `l${i}`, localStokId: l.stokId, vendorKode: l.stokId.toUpperCase(),
      qtyOrdered: l.qty ?? 2, qtyBase: l.qty ?? 2, satuan: 'KG', harga: 10000,
    })),
  };
};

describe.skipIf(!MongoMemoryReplSet)('Fase 3.1 kedaluwarsa & lot pemasok wajib (Mongo replica set)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;
  const today = businessDateIso();

  const setFlag = async (on: boolean) => {
    await db.collection('tenant_settings').updateOne(
      { tenantId: TID },
      { $set: { 'features.lotExpiryRequired': on } },
      { upsert: true },
    );
  };
  const stockOf = async (stokId: string) => Number(
    (await db.collection('stok_lokasi').findOne({ tenantId: TID, stokId, lokasiKode: 'GKERING' }))?.qty ?? 0,
  );
  const grnLots = (grnId: string) => db.collection('ingredient_lots').find({ grnId }).sort({ lineIndex: 1 }).toArray();

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('lot_expiry_it');
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });
    await db.collection('products').insertMany([
      product('noshelf'),
      product('shelf', { shelfLifeDays: 7 }),
      product('lotreq', { shelfLifeDays: 10, requiresLotNo: true }),
      product('canon', { shelfLifeDays: 5, requiresLotNo: true }),
      product('vcopy', { kode: 'CANON', syncSource: 'sales.app', vendorTenantId: 'v1', vendorStokId: 'vs-1', mergedInto: 'canon' }),
      product('adj-noshelf'),
      product('adj-shelf', { shelfLifeDays: 3 }),
      product('rel', { shelfLifeDays: 9 }),
    ]);
    await db.collection('product_uom').insertMany(
      ['noshelf', 'shelf', 'lotreq', 'canon', 'vcopy', 'adj-noshelf', 'adj-shelf', 'rel'].map((id) => ({
        id: `u-${id}`, tenantId: TID, productId: id, satuan: 'KG', isBase: true, factorToBase: 1, aktif: true, sortOrder: 0,
      })),
    );
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  beforeEach(async () => {
    await db.collection('tenant_settings').deleteMany({ tenantId: TID });
  });

  it('flag off: tanpa isian & masa simpan → jalur lama +30 hari, ditandai DEFAULT', async () => {
    const grn = grnOf([{ stokId: 'noshelf' }]);
    const res = await applyGrnStockPosting(db, TID, grn as never, [], undefined, actor);
    expect(res.error).toBeUndefined();
    const [lot] = await grnLots(grn.id);
    expect(lot).toMatchObject({ expiryDate: addShelfDays(today, 30), expirySource: 'DEFAULT' });
    expect(res.itemsFull![0]).toMatchObject({ expirySource: 'DEFAULT' });
  });

  it('flag on: baris tanpa tanggal & tanpa masa simpan → GRN ditolak, stok/lot/kartu tidak berubah', async () => {
    await setFlag(true);
    const before = await stockOf('noshelf');
    const grn = grnOf([{ stokId: 'shelf' }, { stokId: 'noshelf' }]);
    const res = await applyGrnStockPosting(db, TID, grn as never, [], undefined, actor);
    expect(res.error).toMatch(/Tanggal kedaluwarsa wajib untuk Produk noshelf/);
    expect(await stockOf('noshelf')).toBe(before);
    expect(await stockOf('shelf')).toBe(0);
    expect(await grnLots(grn.id)).toHaveLength(0);
    expect(await db.collection('stok_kartu').countDocuments({ sourceId: grn.id })).toBe(0);
  });

  it('flag on: isian → INPUT, kosong + masa simpan → MASTER_SHELF', async () => {
    await setFlag(true);
    const exp = addShelfDays(today, 20);
    const grn = grnOf([{ stokId: 'noshelf' }, { stokId: 'shelf' }]);
    const res = await applyGrnStockPosting(db, TID, grn as never, [
      { lineIndex: 0, qty: 2, expiryDate: exp },
      { lineIndex: 1, qty: 2 },
    ], undefined, actor);
    expect(res.error).toBeUndefined();
    const lots = await grnLots(grn.id);
    expect(lots.map((l) => [l.productId, l.expiryDate, l.expirySource])).toEqual([
      ['noshelf', exp, 'INPUT'],
      ['shelf', addShelfDays(today, 7), 'MASTER_SHELF'],
    ]);
    expect(await stockOf('shelf')).toBe(2);
  });

  it('flag on: tanggal sebelum hari terima atau tidak valid ditolak (walau ada masa simpan)', async () => {
    await setFlag(true);
    const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const expired = await applyGrnStockPosting(db, TID, grnOf([{ stokId: 'shelf' }]) as never, [
      { lineIndex: 0, qty: 2, expiryDate: yesterday },
    ], undefined, actor);
    expect(expired.error).toMatch(/sudah kedaluwarsa/);
    const invalid = await applyGrnStockPosting(db, TID, grnOf([{ stokId: 'shelf' }]) as never, [
      { lineIndex: 0, qty: 2, expiryDate: '2026-02-30' },
    ], undefined, actor);
    expect(invalid.error).toMatch(/tidak valid/);
  });

  it('flag on: requiresLotNo tanpa no. lot pemasok ditolak; dengan no. lot tersimpan di lot & baris GRN', async () => {
    await setFlag(true);
    const bad = await applyGrnStockPosting(db, TID, grnOf([{ stokId: 'lotreq' }]) as never, [], undefined, actor);
    expect(bad.error).toMatch(/No\. lot pemasok wajib untuk Produk lotreq/);

    const grn = grnOf([{ stokId: 'lotreq' }]);
    const res = await applyGrnStockPosting(db, TID, grn as never, [
      { lineIndex: 0, qty: 2, supplierLotNo: '  LOT-ABC-01 ' },
    ], undefined, actor);
    expect(res.error).toBeUndefined();
    const [lot] = await grnLots(grn.id);
    expect(lot).toMatchObject({ supplierLotNo: 'LOT-ABC-01', expirySource: 'MASTER_SHELF', expiryDate: addShelfDays(today, 10) });
    expect(res.itemsFull![0]).toMatchObject({ supplierLotNo: 'LOT-ABC-01' });
  });

  it('flag off: isian tanggal tetap divalidasi (tidak jatuh diam-diam ke default)', async () => {
    const bad = await applyGrnStockPosting(db, TID, grnOf([{ stokId: 'noshelf' }]) as never, [
      { lineIndex: 0, qty: 2, expiryDate: '31-12-2026' },
    ], undefined, actor);
    expect(bad.error).toMatch(/tidak valid/);
  });

  it('relokasi sebagian lot ke gudang lain mempertahankan sumber kedaluwarsa & no. lot pemasok', async () => {
    await setFlag(true);
    const grn = grnOf([{ stokId: 'rel', qty: 3 }]);
    const res = await applyGrnStockPosting(db, TID, grn as never, [
      { lineIndex: 0, qty: 3, supplierLotNo: 'SUP-9' },
    ], undefined, actor);
    expect(res.error).toBeUndefined();
    const moved = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'TRANSFER', sourceId: 'tr-31', noTransaksi: 'TR-31', keterangan: 'tr',
      lines: [{ lineRef: '1:OUT', productId: 'rel', warehouseKode: 'GKERING', deltaQtyBase: -1, lotPolicy: { mode: 'RELOCATE', toWarehouseKode: 'DAPUR1' } }],
    } as never);
    expect(moved.ok).toBe(true);
    const [src] = await grnLots(grn.id);
    const clone = await db.collection('ingredient_lots').findOne({ productId: 'rel', warehouseKode: 'DAPUR1' });
    expect(clone).toMatchObject({
      relocatedFromLotId: src.id, qty: 1, supplierLotNo: 'SUP-9', supplierId: 'v1',
      expirySource: 'MASTER_SHELF', expiryDate: addShelfDays(today, 9), receivedAt: today,
    });
  });

  it('flag off: requiresLotNo tidak memblokir', async () => {
    const res = await applyGrnStockPosting(db, TID, grnOf([{ stokId: 'lotreq' }]) as never, [], undefined, actor);
    expect(res.error).toBeUndefined();
  });

  it('baris salinan vendor tergabung: aturan lot dari item kanonik', async () => {
    await setFlag(true);
    const bad = await applyGrnStockPosting(db, TID, grnOf([{ stokId: 'vcopy' }]) as never, [], undefined, actor);
    expect(bad.error).toMatch(/No\. lot pemasok wajib/);
    const grn = grnOf([{ stokId: 'vcopy' }]);
    const res = await applyGrnStockPosting(db, TID, grn as never, [
      { lineIndex: 0, qty: 2, supplierLotNo: 'L1' },
    ], undefined, actor);
    expect(res.error).toBeUndefined();
    const [lot] = await grnLots(grn.id);
    expect(lot).toMatchObject({ productId: 'canon', expirySource: 'MASTER_SHELF', expiryDate: addShelfDays(today, 5) });

    const enriched = await enrichGrnDocWithProducts(db, grn as never);
    expect(enriched).toMatchObject({ lotExpiryRequired: true });
    expect((enriched!.items as Json[])[0].product).toMatchObject({ id: 'vcopy', shelfLifeDays: 5, requiresLotNo: true });
  });

  const adjust = (productId: string, delta: number) => postStockMovements(db, undefined, {
    tenantId: TID, sourceType: 'PENYESUAIAN', sourceId: `adj-${productId}-${Date.now()}`, noTransaksi: `PS-${productId}`,
    keterangan: 'hitung fisik',
    lines: [{ lineRef: '1', productId, warehouseKode: 'GKERING', deltaQtyBase: delta, binPolicy: 'NONE', lotPolicy: { mode: 'VARIANCE' } }],
  } as never);

  it('penyesuaian plus tanpa lot: masa simpan master → lot MASTER_SHELF', async () => {
    await setFlag(true);
    const res = await adjust('adj-shelf', 4);
    expect(res.ok).toBe(true);
    const lot = await db.collection('ingredient_lots').findOne({ tenantId: TID, productId: 'adj-shelf' });
    expect(lot).toMatchObject({ sourceType: 'PENYESUAIAN', qty: 4, expirySource: 'MASTER_SHELF', expiryDate: addShelfDays(today, 3) });
  });

  it('penyesuaian plus tanpa lot & tanpa masa simpan: flag on → ditolak & rollback; flag off → DEFAULT', async () => {
    await setFlag(true);
    const rejected = await adjust('adj-noshelf', 4);
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).toMatch(/isi masa simpan di master produk/);
    expect(await stockOf('adj-noshelf')).toBe(0);
    expect(await db.collection('ingredient_lots').countDocuments({ tenantId: TID, productId: 'adj-noshelf' })).toBe(0);
    expect(await db.collection('stok_kartu').countDocuments({ tenantId: TID, stokId: 'adj-noshelf' })).toBe(0);

    await setFlag(false);
    const legacy = await adjust('adj-noshelf', 4);
    expect(legacy.ok).toBe(true);
    const lot = await db.collection('ingredient_lots').findOne({ tenantId: TID, productId: 'adj-noshelf' });
    expect(lot).toMatchObject({ expirySource: 'DEFAULT', expiryDate: addShelfDays(today, 30) });
  });
});
