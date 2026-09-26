/**
 * Migrasi 0005 (lot tertinggal di gudang lama disamakan dengan saldo gudang) dan 0006 (hapus baris resep
 * sesuai keputusan). Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { realignOrphanLotsMigration, type LotRealignRow } from '@/lib/migrations/0005-realign-orphan-lots';
import { removeRecipeLinesMigration, type RemoveRecipeLineResult } from '@/lib/migrations/0006-remove-recipe-lines';
import { planLotRealign } from '@/lib/stock-ledger';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-lot-realign';
type Json = Record<string, unknown>;

const product = (id: string, gudangKode: string) => ({
  id, tenantId: TID, kode: id.toUpperCase(), nama: `Produk ${id}`, satuan: 'ONS', itemRole: 'INGREDIENT',
  aktif: true, gudangKode, hargaBeli: 1000, updatedAt: new Date('2026-09-01'),
});
const lokasi = (stokId: string, lokasiKode: string, qty: number) => ({ id: `lok-${stokId}-${lokasiKode}`, tenantId: TID, stokId, lokasiKode, qty });
const lot = (id: string, productId: string, warehouseKode: string, qtyRemaining: number, expiryDate: string, extra: Json = {}) => ({
  id, tenantId: TID, lotNo: `L-${id}`, productId, warehouseKode, qty: qtyRemaining, qtyRemaining, expiryDate,
  receivedAt: '2026-09-10', status: 'ACTIVE', updatedAt: new Date('2026-09-10'), ...extra,
});

describe.skipIf(!MongoMemoryReplSet)('Migrasi 0005 lot tertinggal + 0006 hapus baris resep (Mongo replica set)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;
  const now = new Date('2026-09-26T03:00:00Z');
  const ctx = (extra: Json = {}) => ({ db, tenantId: TID, now, actor: 'it', ...extra });
  const lotsOf = (productId: string) => db.collection('ingredient_lots')
    .find({ tenantId: TID, productId, status: { $in: ['ACTIVE', 'EXPIRED'] }, qtyRemaining: { $gt: 0 } })
    .project({ _id: 0, id: 1, warehouseKode: 1, qtyRemaining: 1 }).sort({ warehouseKode: 1, id: 1 }).toArray();

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('lot_realign_it');
    await db.collection('recipe_revisions').createIndexes([
      { key: { tenantId: 1, recipeId: 1, revision: 1 }, name: 'uniq_recipe_revisions_recipe_rev', unique: true },
      { key: { tenantId: 1, id: 1 }, name: 'uniq_recipe_revisions_id', unique: true },
    ]);
    await db.collection('products').insertMany([
      product('susu', 'GBASAH'),
      product('kunyit', 'GKERING'),
      product('pokcoy', 'GBASAH'),
      product('beres', 'GKERING'),
    ]);
    await db.collection('stok_lokasi').insertMany([
      lokasi('susu', 'GBASAH', 85),
      lokasi('kunyit', 'GKERING', 8),
      lokasi('pokcoy', 'GBASAH', 0),
      lokasi('beres', 'GKERING', 10),
    ]);
    await db.collection('ingredient_lots').insertMany([
      // Pindah gudang lama: saldo ke GBASAH, lot tertinggal di GKERING; pemakaian di GBASAH tanpa lot.
      lot('susu-home', 'susu', 'GBASAH', 80, '2026-12-01'),
      lot('susu-old-a', 'susu', 'GKERING', 8, '2026-10-01'),
      lot('susu-old-b', 'susu', 'GKERING', 680, '2026-10-18'),
      lot('kunyit-home', 'kunyit', 'GKERING', 8, '2026-10-20'),
      lot('kunyit-old', 'kunyit', 'GBASAH', 6, '2026-10-05'),
      lot('pokcoy-old', 'pokcoy', 'GKERING', 1480, '2026-09-30'),
      lot('beres-1', 'beres', 'GKERING', 10, '2026-11-01'),
    ]);
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('0005 dry-run: rencana pindah ke gudang home sebanyak kekurangan lot, sisanya dihabiskan; tanpa tulis', async () => {
    const dry = await realignOrphanLotsMigration.run({ ...ctx(), dryRun: true });
    expect(dry.changed).toBe(0);
    expect(dry.before).toMatchObject({ products: 3, lines: 3, consume: 683 + 6 + 1480, relocate: 5 });
    const rows = (dry.after as { rows: LotRealignRow[] }).rows;
    const byId = new Map(rows.map((r) => [r.productId, r]));
    expect(byId.get('susu')!.lines).toEqual([
      { warehouseKode: 'GKERING', lotQty: 688, stokQty: 0, excess: 688, consume: 683, relocate: 5 },
    ]);
    expect(byId.get('kunyit')!.lines).toEqual([
      { warehouseKode: 'GBASAH', lotQty: 6, stokQty: 0, excess: 6, consume: 6, relocate: 0 },
    ]);
    expect(byId.get('pokcoy')!.lines[0]).toMatchObject({ consume: 1480, relocate: 0 });
    expect(byId.has('beres')).toBe(false);
    expect(await lotsOf('susu')).toHaveLength(3);
  });

  it('0005 apply: FEFO habiskan lot tertua, lot terbaru pindah ke home; Σ lot = saldo gudang; audit per produk', async () => {
    const res = await realignOrphanLotsMigration.run({ ...ctx(), dryRun: false });
    expect(res.changed).toBe(3);
    expect((res.after as { rows: LotRealignRow[] }).rows.every((r) => r.result === 'FIXED')).toBe(true);
    expect((res.after as { remaining: unknown[] }).remaining).toEqual([]);

    expect(await lotsOf('susu')).toEqual([
      { id: 'susu-home', warehouseKode: 'GBASAH', qtyRemaining: 80 },
      { id: 'susu-old-b', warehouseKode: 'GBASAH', qtyRemaining: 5 },
    ]);
    expect(await db.collection('ingredient_lots').findOne({ id: 'susu-old-a' })).toMatchObject({ status: 'CONSUMED', qtyRemaining: 0 });
    expect(await lotsOf('kunyit')).toEqual([{ id: 'kunyit-home', warehouseKode: 'GKERING', qtyRemaining: 8 }]);
    expect(await lotsOf('pokcoy')).toEqual([]);
    expect(await lotsOf('beres')).toEqual([{ id: 'beres-1', warehouseKode: 'GKERING', qtyRemaining: 10 }]);
    expect(await db.collection('stok_lokasi').findOne({ stokId: 'susu' })).toMatchObject({ qty: 85 });

    const audit = await db.collection('audit_log').findOne({ tenantId: TID, action: 'LOT_REALIGN', entityId: 'susu' });
    expect(audit?.metadata).toMatchObject({
      migration: '0005-realign-orphan-lots',
      applied: { consumed: 683, relocated: 5, consumeShortfall: 0, relocateShortfall: 0 },
    });
    expect(await db.collection('audit_log').countDocuments({ tenantId: TID, action: 'LOT_REALIGN' })).toBe(3);
  });

  it('0005 jalankan ulang: idempoten', async () => {
    const again = await realignOrphanLotsMigration.run({ ...ctx(), dryRun: false });
    expect(again.changed).toBe(0);
    expect(await planLotRealign(db, TID)).toEqual([]);
  });

  describe('0006 hapus baris resep', () => {
    const cabaiKg = { productId: 'cabai-ani', productKode: 'B799228', satuan: 'KG', qty: 2, factorToBase: 10, baseSatuan: 'ONS' };
    const cabaiGr = { productId: 'cabai-dawam', productKode: 'B799228', satuan: 'GR', qty: 400, factorToBase: 0.01, baseSatuan: 'ONS' };
    const telur = { productId: 'telur', productKode: 'B313252', satuan: 'PCS', qty: 100, factorToBase: 1, baseSatuan: 'PCS' };
    const results = (r: { after: unknown }) => (r.after as { results: RemoveRecipeLineResult[] }).results;
    const decision = { recipeKode: 'RSP-0043', productId: 'cabai-dawam', productKode: 'B799228', satuan: 'GR' };

    beforeAll(async () => {
      await db.collection('recipes').insertOne({
        id: 'rcp-43', tenantId: TID, kode: 'RSP-0043', nama: 'Telur Dadar Balado', version: 1, effectiveDate: '2026-09-01',
        aktif: true, yieldQty: 100, updatedAt: new Date('2026-09-20'), lines: [cabaiKg, cabaiGr, telur],
      });
    });

    it('dry-run & keputusan tidak cocok satuan → tidak menulis', async () => {
      const dry = await removeRecipeLinesMigration.run({ ...ctx({ options: { decisions: [decision] } }), dryRun: true });
      expect(results(dry)).toEqual([expect.objectContaining({ result: 'WOULD_REMOVE', removedLines: 1 })]);
      const wrong = await removeRecipeLinesMigration.run({
        ...ctx({ options: { decisions: [{ ...decision, satuan: 'KG' }] } }), dryRun: false,
      });
      expect(results(wrong)[0]).toMatchObject({ result: 'MISMATCH' });
      expect(wrong.changed).toBe(0);
      expect((await db.collection('recipes').findOne({ id: 'rcp-43' }))!.lines).toHaveLength(3);
    });

    it('apply: baris dihapus lewat revisi resep + audit; ulang → NOT_FOUND', async () => {
      const res = await removeRecipeLinesMigration.run({ ...ctx({ options: { decisions: [decision] } }), dryRun: false });
      expect(res.changed).toBe(1);
      const recipe = await db.collection('recipes').findOne({ id: 'rcp-43' });
      expect(recipe!.lines).toEqual([cabaiKg, telur]);
      expect(recipe!.currentRevisionId).toBeTruthy();
      const revs = await db.collection('recipe_revisions').find({ tenantId: TID, recipeId: 'rcp-43' }).sort({ revision: 1 }).toArray();
      expect(revs.map((r) => r.lines.length)).toEqual([3, 2]);
      const audit = await db.collection('audit_log').findOne({ tenantId: TID, action: 'RECIPE_UPDATE', entityId: 'rcp-43' });
      expect(audit?.metadata).toMatchObject({ migration: '0006-remove-recipe-lines', removed: [cabaiGr] });

      const again = await removeRecipeLinesMigration.run({ ...ctx({ options: { decisions: [decision] } }), dryRun: false });
      expect(results(again)[0]).toMatchObject({ result: 'NOT_FOUND' });
      expect(again.changed).toBe(0);
    });
  });
});
