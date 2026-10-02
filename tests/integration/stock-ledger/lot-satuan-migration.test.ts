/**
 * Migrasi 0010: satuan lot & inspeksi QC disamakan ke satuan dasar produk; qty tidak berubah;
 * tenant lain tidak disentuh; idempoten.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { normalizeLotSatuanMigration } from '@/lib/migrations/0010-normalize-lot-satuan';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-lot-satuan';

describe.skipIf(!MongoMemoryReplSet)('0010 normalisasi satuan lot (Mongo replica set)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;
  const now = new Date('2026-09-29T15:00:00Z');
  const run = (dryRun: boolean) => normalizeLotSatuanMigration.run({ db, tenantId: TID, now, dryRun, actor: 'it' });

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('lot_satuan_it');
    await db.collection('products').insertMany([
      { id: 'tomat', tenantId: TID, kode: 'TOMAT', satuan: 'ONS' },
      { id: 'susu', tenantId: TID, kode: 'SUSU', satuan: 'DUS' },
      { id: 'beras', tenantId: TID, kode: 'BERAS', satuan: 'KG' },
      { id: 'tomat', tenantId: 'other', kode: 'TOMAT', satuan: 'ONS' },
    ]);
    // UOM base menang atas denorm products.satuan
    await db.collection('product_uom').insertMany([
      { id: 'u-susu-pcs', tenantId: TID, productId: 'susu', satuan: 'PCS', isBase: true, factorToBase: 1, aktif: true },
      { id: 'u-susu-dus', tenantId: TID, productId: 'susu', satuan: 'DUS', isBase: false, factorToBase: 24, aktif: true },
    ]);
    await db.collection('ingredient_lots').insertMany([
      { id: 'lot-tomat', tenantId: TID, productId: 'tomat', satuan: 'KG', qty: 30, qtyRemaining: 30 },
      { id: 'lot-susu', tenantId: TID, productId: 'susu', satuan: 'DUS', qty: 48, qtyRemaining: 48 },
      { id: 'lot-beras', tenantId: TID, productId: 'beras', satuan: 'kg', qty: 50, qtyRemaining: 50 },
      { id: 'lot-other', tenantId: 'other', productId: 'tomat', satuan: 'KG', qty: 30, qtyRemaining: 30 },
    ]);
    await db.collection('lot_inspections').insertOne({ id: 'insp-tomat', tenantId: TID, productId: 'tomat', satuan: 'KG', qtyPassed: 30 });
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('dry-run melaporkan tanpa menulis', async () => {
    const r = await run(true);
    expect(r.changed).toBe(0);
    expect((r.before as { total: number }).total).toBe(3);
    expect((await db.collection('ingredient_lots').findOne({ id: 'lot-tomat' }))?.satuan).toBe('KG');
  });

  it('apply menyamakan satuan ke base, qty utuh, tenant lain tidak disentuh, idempoten', async () => {
    const r = await run(false);
    expect(r.changed).toBe(3);
    const tomat = await db.collection('ingredient_lots').findOne({ tenantId: TID, id: 'lot-tomat' });
    expect(tomat).toMatchObject({ satuan: 'ONS', satuanLegacy: 'KG', qty: 30, qtyRemaining: 30 });
    expect((await db.collection('ingredient_lots').findOne({ id: 'lot-susu' }))?.satuan).toBe('PCS');
    expect((await db.collection('ingredient_lots').findOne({ id: 'lot-beras' }))?.satuanLegacy).toBeUndefined();
    expect((await db.collection('lot_inspections').findOne({ id: 'insp-tomat' }))?.satuan).toBe('ONS');
    expect((await db.collection('ingredient_lots').findOne({ id: 'lot-other' }))?.satuan).toBe('KG');
    expect(await db.collection('audit_log').countDocuments({ tenantId: TID, action: 'LOT_SATUAN_NORMALIZE' })).toBe(1);

    const again = await run(false);
    expect(again.changed).toBe(0);
  });

  it('run ulang setelah satuan dasar berubah tidak menimpa satuanLegacy asli', async () => {
    await db.collection('products').updateOne({ tenantId: TID, id: 'tomat' }, { $set: { satuan: 'GRAM' } });
    const r = await run(false);
    expect(r.changed).toBe(2);
    const tomat = await db.collection('ingredient_lots').findOne({ tenantId: TID, id: 'lot-tomat' });
    expect(tomat).toMatchObject({ satuan: 'GRAM', satuanLegacy: 'KG' });
  });
});
