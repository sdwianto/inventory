/**
 * Fase 2.4 — products.stok & stokDisplay hanya ditulis buku stok (dalam sesi posting) dan migrasi 0004
 * menyamakan master yang terlanjur selisih dengan Σ stok_lokasi, dengan audit per produk.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { fixMasterStockDriftMigration, type MasterDriftRow } from '@/lib/migrations/0004-fix-master-stock-drift';
import {
  formatMasterStokDisplay,
  planProductsMasterStock,
  postStockMovements,
  refreshProductsMasterStock,
} from '@/lib/stock-ledger';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';
import { runInTransactionOnDb } from '@/lib/api/transaction';
import type { ProductUom } from '@/lib/uom/types';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-24';
type Json = Record<string, unknown>;

const product = (id: string, extra: Json = {}) => ({
  id, tenantId: TID, kode: id.toUpperCase(), nama: `Produk ${id}`, satuan: 'KG', itemRole: 'INGREDIENT',
  aktif: true, syncSource: 'local', gudangKode: 'GKERING', hargaBeli: 10000, stok: 0, stokDisplay: '0 KG',
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  ...extra,
});
const uom = (id: string, productId: string, satuan: string, factorToBase: number, sortOrder: number): ProductUom => ({
  id, tenantId: TID, productId, satuan, isBase: factorToBase === 1, factorToBase, barcode: '', sortOrder,
  hargaEcer: 0, hargaGrosir: 0, hargaSpesial: 0, aktif: true,
});
const lokasi = (stokId: string, qty: number) => ({ id: `lok-${stokId}`, tenantId: TID, stokId, lokasiKode: 'GKERING', qty });
const kartu = (stokId: string, masuk: number) => ({
  id: `k-${stokId}`, tenantId: TID, stokId, lokasiKode: 'GKERING', masuk, keluar: 0, sourceType: 'OPENING', sourceId: `op-${stokId}`,
  lineRef: stokId, noTransaksi: 'OPEN', postingDate: new Date('2026-01-02'),
});

describe.skipIf(!MongoMemoryReplSet)('Fase 2.4 stok master = Σ gudang (Mongo replica set)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;
  const now = new Date('2026-09-25T03:00:00Z');
  const ctx = () => ({ db, tenantId: TID, now, actor: 'it' });
  const rowsOf = (report: { after: unknown }) => (report.after as { rows: MasterDriftRow[] }).rows;
  const row = (report: { after: unknown }, id: string) => rowsOf(report).find((r) => r.productId === id);
  const karungUoms = [uom('u-lbl-kg', 'p-label', 'KG', 1, 0), uom('u-lbl-karung', 'p-label', 'KARUNG', 25, 1)];
  const product$ = (id: string) => db.collection('products').findOne({ tenantId: TID, id });

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('master_drift_it');
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });

    await db.collection('products').insertMany([
      // Bug GRN lama: gudang 10, master 7.
      product('p-drift', { stok: 7, stokDisplay: '7 KG' }),
      // Nonaktif, master 5 tanpa baris gudang.
      product('p-inactive', { aktif: false, stok: 5, stokDisplay: '5 KG' }),
      // Tipe string, qty sama.
      product('p-norm', { stok: '4', stokDisplay: '4 KG' }),
      // Qty cocok, label belum memuat satuan alternatif.
      product('p-label', { stok: 25, stokDisplay: '25 KG', uomCount: 2 }),
      // Sudah konsisten.
      product('p-ok', { stok: 3, stokDisplay: '3 KG' }),
      // Master = gudang 8, kartu 6 → hanya dilaporkan.
      product('p-kartu', { stok: 8, stokDisplay: '8 KG' }),
    ]);
    await db.collection('product_uom').insertMany(karungUoms);
    await db.collection('stok_lokasi').insertMany([
      lokasi('p-drift', 10), lokasi('p-norm', 4), lokasi('p-label', 25), lokasi('p-ok', 3), lokasi('p-kartu', 8),
    ]);
    await db.collection('stok_kartu').insertMany([
      kartu('p-drift', 10), kartu('p-norm', 4), kartu('p-label', 25), kartu('p-ok', 3), kartu('p-kartu', 6),
    ]);
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('dry-run: klasifikasi selisih master tanpa menulis', async () => {
    const dry = await fixMasterStockDriftMigration.run({ ...ctx(), dryRun: true });
    expect(dry.changed).toBe(0);
    expect(dry.before).toMatchObject({ products: 6, drift: { stok: 2, normalisasi: 1, label: 1 }, lokasiVsKartu: 1 });
    expect(row(dry, 'p-drift')).toMatchObject({ kind: 'STOK', masterBefore: 7, gudang: 10, selisih: 3, result: 'WOULD_FIX' });
    expect(row(dry, 'p-inactive')).toMatchObject({ kind: 'STOK', aktif: false, masterBefore: 5, gudang: 0, selisih: -5 });
    expect(row(dry, 'p-norm')).toMatchObject({ kind: 'NORMALISASI', selisih: 0 });
    expect(row(dry, 'p-label')).toMatchObject({ kind: 'LABEL', displayBefore: '25 KG' });
    expect(row(dry, 'p-label')!.displayAfter).toMatch(/KARUNG/);
    expect(row(dry, 'p-ok')).toBeUndefined();
    expect(row(dry, 'p-kartu')).toBeUndefined();
    expect((dry.after as { lokasiVsKartu: Json[] }).lokasiVsKartu).toEqual([
      expect.objectContaining({ productId: 'p-kartu', gudang: 8, kartu: 6, selisih: 2 }),
    ]);
    expect(await product$('p-drift')).toMatchObject({ stok: 7 });
  });

  it('apply: master = Σ gudang untuk semua produk, audit per produk yang qty-nya selisih', async () => {
    const res = await fixMasterStockDriftMigration.run({ ...ctx(), dryRun: false });
    expect(res.changed).toBe(4);
    expect(rowsOf(res).every((r) => r.result === 'FIXED')).toBe(true);
    expect((res.after as { drift: Json }).drift).toEqual({ stok: 0, normalisasi: 0, label: 0 });

    expect(await product$('p-drift')).toMatchObject({ stok: 10, stokDisplay: '10 KG' });
    expect(await product$('p-inactive')).toMatchObject({ stok: 0, aktif: false });
    expect((await product$('p-norm'))!.stok).toBe(4);
    expect((await product$('p-label'))!.stokDisplay).toBe(formatMasterStokDisplay(25, TID, 'p-label', { satuan: 'KG' }, karungUoms));

    const audit = await db.collection('audit_log').findOne({ tenantId: TID, action: 'STOCK_MASTER_RECOMPUTE', entityId: 'p-drift' });
    expect(audit?.metadata).toMatchObject({
      migration: '0004-fix-master-stock-drift', before: { stok: 7 }, after: { stok: 10 }, selisih: 3,
    });
    expect(await db.collection('audit_log').countDocuments({ tenantId: TID, action: 'STOCK_MASTER_RECOMPUTE', entityType: 'product', entityId: 'p-inactive' })).toBe(1);
    const cosmetic = await db.collection('audit_log').findOne({ tenantId: TID, action: 'STOCK_MASTER_RECOMPUTE', entityId: TID });
    expect((cosmetic?.metadata as { productIds: string[] }).productIds.sort()).toEqual(['p-label', 'p-norm']);

    // Gudang vs kartu tidak disentuh migrasi ini.
    expect(await db.collection('stok_lokasi').findOne({ stokId: 'p-kartu' })).toMatchObject({ qty: 8 });
    expect(await product$('p-kartu')).toMatchObject({ stok: 8 });
  });

  it('jalankan ulang: idempoten, tidak ada perubahan', async () => {
    const again = await fixMasterStockDriftMigration.run({ ...ctx(), dryRun: false });
    expect(again.changed).toBe(0);
    expect(again.before).toMatchObject({ drift: { stok: 0, normalisasi: 0, label: 0 } });
  });

  it('posting: stok & label master ditulis di sesi yang sama; transaksi batal → master tidak berubah', async () => {
    const posted = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'PENYESUAIAN', sourceId: 'adj-1', noTransaksi: 'PS-1', keterangan: 'uji',
      lines: [{ lineRef: 'p-label', productId: 'p-label', warehouseKode: 'GKERING', deltaQtyBase: 25, binPolicy: 'NONE' }],
    } as never);
    expect(posted.ok).toBe(true);
    const after = await product$('p-label');
    expect(after!.stok).toBe(50);
    expect(after!.stokDisplay).toBe(formatMasterStokDisplay(50, TID, 'p-label', { satuan: 'KG' }, karungUoms));

    await expect(runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const res = await postStockMovements(txDb, session, {
        tenantId: TID, sourceType: 'PENYESUAIAN', sourceId: 'adj-2', noTransaksi: 'PS-2', keterangan: 'uji batal',
        lines: [{ lineRef: 'p-label', productId: 'p-label', warehouseKode: 'GKERING', deltaQtyBase: 5, binPolicy: 'NONE' }],
      } as never);
      expect(res.ok).toBe(true);
      throw new Error('batal');
    })).rejects.toThrow('batal');
    expect(await product$('p-label')).toMatchObject({ stok: 50, stokDisplay: after!.stokDisplay });
    expect(await db.collection('stok_lokasi').findOne({ stokId: 'p-label' })).toMatchObject({ qty: 50 });
  });

  it('GRN: master = Σ gudang setelah terima barang (tanpa tulis label kedua)', async () => {
    const grn = {
      id: 'grn-24', tenantId: TID, noGRN: 'GRN-24', noDO: 'DO-24',
      items: [{ lineId: 'l1', localStokId: 'p-label', vendorKode: 'P-LABEL', qtyOrdered: 2, qtyBase: 50, uomId: 'u-lbl-karung', satuan: 'KARUNG', harga: 250000 }],
    };
    const res = await applyGrnStockPosting(db, TID, grn as never, [], undefined, { userId: 'u1', userName: 'Tester' } as never);
    expect(res.error).toBeUndefined();
    const p = await product$('p-label');
    expect(p!.stok).toBe(100);
    expect(p!.stokDisplay).toBe(formatMasterStokDisplay(100, TID, 'p-label', { satuan: 'KG' }, karungUoms));
    const [plan] = await planProductsMasterStock(db, TID, ['p-label']);
    expect(plan).toMatchObject({ stokChanged: false, displayChanged: false });
  });

  it('UOM berubah di luar posting: refresh menyamakan label lewat buku stok', async () => {
    await db.collection('product_uom').insertOne(uom('u-ok-sak', 'p-ok', 'SAK', 3, 1));
    await db.collection('product_uom').insertOne(uom('u-ok-kg', 'p-ok', 'KG', 1, 0));
    const [stale] = await planProductsMasterStock(db, TID, ['p-ok']);
    expect(stale).toMatchObject({ stokChanged: false, displayChanged: true });

    expect(await refreshProductsMasterStock(db, TID, ['p-ok'])).toEqual({ updated: 1, skipped: 0 });
    expect((await product$('p-ok'))!.stokDisplay).toMatch(/SAK/);
    expect(await refreshProductsMasterStock(db, TID, ['p-ok'])).toEqual({ updated: 0, skipped: 0 });
  });
});
