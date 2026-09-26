/**
 * Metrik G "float dust tetap 0": migrasi 0009 membulatkan saldo lama yang hanya bergalat float (≤ 1e-6)
 * di stok_lokasi, stok_bin, lot, dan master; selisih nyata tidak disentuh; idempoten; rekonsiliasi stok bersih.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { normalizeStockDustMigration } from '@/lib/migrations/0009-normalize-stock-dust';
import { planStockDust } from '@/lib/stock-ledger';
import { detectStockRecon } from '@/lib/recon/stock-recon';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-dust';
const DUST = 1.9300000000000002;

describe.skipIf(!MongoMemoryReplSet)('0009 normalisasi float dust saldo stok (Mongo replica set)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;
  const now = new Date('2026-09-26T03:00:00Z');
  const run = (dryRun: boolean) => normalizeStockDustMigration.run({ db, tenantId: TID, now, dryRun, actor: 'it' });

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('stock_dust_it');
    const base = { tenantId: TID, satuan: 'KG', aktif: true, gudangKode: 'GKERING', hargaBeli: 1000 };
    await db.collection('products').insertMany([
      { ...base, id: 'p-dust', kode: 'DUST', nama: 'Semangka', stok: DUST, stokDisplay: '1.93 KG' },
      { ...base, id: 'p-real', kode: 'REAL', nama: 'Presisi', stok: 0.12345, stokDisplay: '0.1235 KG' },
      { ...base, id: 'p-clean', kode: 'CLEAN', nama: 'Bersih', stok: 2.5, stokDisplay: '2.5 KG' },
      { ...base, id: 'p-other', kode: 'OTHER', nama: 'Tenant lain', tenantId: 'other', stok: DUST },
    ]);
    await db.collection('stok_lokasi').insertMany([
      { id: 'l1', tenantId: TID, stokId: 'p-dust', lokasiKode: 'GKERING', qty: DUST },
      { id: 'l2', tenantId: TID, stokId: 'p-real', lokasiKode: 'GKERING', qty: 0.12345 },
      { id: 'l3', tenantId: TID, stokId: 'p-clean', lokasiKode: 'GKERING', qty: 2.5 },
      { id: 'l4', tenantId: 'other', stokId: 'p-other', lokasiKode: 'GKERING', qty: DUST },
    ]);
    await db.collection('stok_bin').insertOne({ id: 'b1', tenantId: TID, stokId: 'p-dust', lokasiKode: 'GKERING', binKode: 'A1', qty: DUST });
    await db.collection('ingredient_lots').insertOne({
      id: 'lot1', tenantId: TID, productId: 'p-dust', warehouseKode: 'GKERING', status: 'ACTIVE', qty: DUST, qtyRemaining: 0.30000000000000004,
    });
    await db.collection('stok_kartu').insertMany([
      { id: 'k1', tenantId: TID, stokId: 'p-dust', lokasiKode: 'GKERING', masuk: 1.93, keluar: 0, sourceType: 'OPENING', sourceId: 'o1', lineRef: '1', tanggal: new Date('2026-01-02'), hargaSatuan: 1000 },
      { id: 'k2', tenantId: TID, stokId: 'p-real', lokasiKode: 'GKERING', masuk: 0.12345, keluar: 0, sourceType: 'OPENING', sourceId: 'o2', lineRef: '1', tanggal: new Date('2026-01-02'), hargaSatuan: 1000 },
      { id: 'k3', tenantId: TID, stokId: 'p-clean', lokasiKode: 'GKERING', masuk: 2.5, keluar: 0, sourceType: 'OPENING', sourceId: 'o3', lineRef: '1', tanggal: new Date('2026-01-02'), hargaSatuan: 1000 },
    ]);
  });

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('dry-run melaporkan dust vs selisih nyata tanpa menulis', async () => {
    const report = await run(true);
    expect(report.changed).toBe(0);
    const before = report.before as { dust: number; real: number; byTarget: Record<string, { dust: number; real: number }> };
    expect(before.byTarget['stok_lokasi.qty']).toEqual({ dust: 1, real: 1 });
    expect(before.byTarget['stok_bin.qty']).toEqual({ dust: 1, real: 0 });
    expect(before.byTarget['ingredient_lots.qty']).toEqual({ dust: 1, real: 0 });
    expect(before.byTarget['ingredient_lots.qtyRemaining']).toEqual({ dust: 1, real: 0 });
    expect(before.byTarget['products.stok']).toEqual({ dust: 1, real: 1 });
    expect((await db.collection('stok_lokasi').findOne({ id: 'l1' }))?.qty).toBe(DUST);
  });

  it('apply membulatkan dust, master dihitung ulang, selisih nyata & tenant lain utuh, audit tercatat', async () => {
    const report = await run(false);
    expect(report.changed).toBeGreaterThan(0);
    expect((await db.collection('stok_lokasi').findOne({ id: 'l1' }))?.qty).toBe(1.93);
    expect((await db.collection('stok_bin').findOne({ id: 'b1' }))?.qty).toBe(1.93);
    const lot = await db.collection('ingredient_lots').findOne({ id: 'lot1' });
    expect(lot?.qty).toBe(1.93);
    expect(lot?.qtyRemaining).toBe(0.3);
    expect((await db.collection('products').findOne({ tenantId: TID, id: 'p-dust' }))?.stok).toBe(1.93);
    expect((await db.collection('stok_lokasi').findOne({ id: 'l2' }))?.qty).toBe(0.12345);
    expect((await db.collection('stok_lokasi').findOne({ id: 'l4' }))?.qty).toBe(DUST);
    expect((await db.collection('products').findOne({ tenantId: 'other', id: 'p-other' }))?.stok).toBe(DUST);
    const audit = await db.collection('audit_log').findOne({ tenantId: TID, action: 'STOCK_DUST_NORMALIZE' });
    expect(audit).toBeTruthy();

    const remaining = await planStockDust(db, TID);
    expect(remaining.filter((r) => r.dust)).toHaveLength(0);
    expect(remaining.filter((r) => !r.dust).map((r) => r.productId)).toEqual(expect.arrayContaining(['p-real']));
  });

  it('idempoten dan rekonsiliasi tidak lagi melaporkan dust produk yang dinormalkan', async () => {
    const again = await run(false);
    expect(again.changed).toBe(0);
    const stock = await detectStockRecon(db, TID, { now });
    const dustIds = stock.findings.filter((f) => f.kind === 'STOCK_FLOAT_DUST').map((f) => f.productId);
    expect(dustIds).not.toContain('p-dust');
    expect(stock.findings.some((f) => f.kind === 'STOCK_HOME_VS_LEDGER' && f.productId === 'p-dust')).toBe(false);
  });
});
