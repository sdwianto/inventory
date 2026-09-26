/**
 * Fase 4 — rata-rata bergerak di buku stok + jurnal pemakaian/penyesuaian (flag costingV2).
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { postStockMovements, type StockMovementLine } from '@/lib/stock-ledger';
import { applyMasterProductStockChange } from '@/lib/stock-ledger/master-stock';
import { postConsumptionJournal } from '@/lib/api/stock-cost-journal';
import { runInTransactionOnDb } from '@/lib/api/transaction';
import { COA } from '@/lib/api/journal-lines';
import { backfillStockCostMigration } from '@/lib/migrations/0007-backfill-stock-cost';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const ON = 'it-costing-on';
const OFF = 'it-costing-off';

const product = (tenantId: string, id: string, extra: Record<string, unknown> = {}) => ({
  id, tenantId, kode: id.toUpperCase(), nama: `Produk ${id}`, satuan: 'KG', itemRole: 'INGREDIENT',
  aktif: true, gudangKode: 'GKERING', hargaBeli: 1000, updatedAt: new Date('2026-09-01'), ...extra,
});

describe.skipIf(!MongoMemoryReplSet)('Fase 4 costingV2 (Mongo replica set)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  const post = (tenantId: string, sourceType: string, sourceId: string, lines: Array<Omit<StockMovementLine, 'lineRef'>>) =>
    runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const res = await postStockMovements(txDb, session, {
        tenantId, sourceType, sourceId, noTransaksi: sourceId, keterangan: sourceId,
        postingDate: new Date('2026-09-26T03:00:00Z'), enforceLedger: false,
        lines: lines.map((l, i) => ({ lineRef: String(i + 1), ...l })),
      });
      if (!res.ok) throw new Error(res.error);
      if (sourceType === 'RELEASE') {
        await postConsumptionJournal(txDb, session, {
          tenantId, sourceType: 'RELEASE', sourceId, noDoc: sourceId, tanggal: new Date(), lines: res.lines,
        });
      }
      return res;
    });

  const kartu = (tenantId: string, sourceId: string) => db.collection('stok_kartu')
    .find({ tenantId, sourceId }).project({ _id: 0, lokasiKode: 1, hargaSatuan: 1, costSource: 1 }).sort({ lineRef: 1 }).toArray();
  const avgOf = async (tenantId: string, id: string) =>
    (await db.collection('products').findOne({ tenantId, id }))?.avgCost as number | undefined;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('costing_v2_it');
    await db.collection('tenant_settings').insertMany([
      { tenantId: ON, features: { costingV2: true } },
      { tenantId: OFF, features: {} },
    ]);
    for (const tid of [ON, OFF]) {
      await db.collection('products').insertMany([
        product(tid, 'beras'),
        product(tid, 'nasi', { itemRole: 'FINISHED_GOOD', hargaBeli: 5000 }),
      ]);
    }
  });

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('rata-rata tertimbang dari GRN, penyesuaian (+) netral, RL dinilai rata-rata, reversal GRN pada harga beli', async () => {
    for (const tid of [ON, OFF]) {
      await post(tid, 'GRN', 'GRN-1', [{ productId: 'beras', warehouseKode: 'GKERING', deltaQtyBase: 10, unitCost: 1000 }]);
      await post(tid, 'GRN', 'GRN-2', [{ productId: 'beras', warehouseKode: 'GKERING', deltaQtyBase: 30, unitCost: 1400 }]);
      await post(tid, 'PENYESUAIAN', 'PS-1', [{ productId: 'beras', warehouseKode: 'GKERING', deltaQtyBase: 2, unitCost: 1000 }]);
      await post(tid, 'RELEASE', 'RL-1', [{ productId: 'beras', warehouseKode: 'GKERING', deltaQtyBase: -8, unitCost: 1000 }]);
      await post(tid, 'GRN_REVERSAL', 'REV-2', [{ productId: 'beras', warehouseKode: 'GKERING', deltaQtyBase: -10, unitCost: 1400 }]);
    }

    expect(await kartu(ON, 'GRN-2')).toEqual([{ lokasiKode: 'GKERING', hargaSatuan: 1400, costSource: 'LINE' }]);
    expect(await kartu(ON, 'PS-1')).toEqual([{ lokasiKode: 'GKERING', hargaSatuan: 1300, costSource: 'AVG' }]);
    expect(await kartu(ON, 'RL-1')).toEqual([{ lokasiKode: 'GKERING', hargaSatuan: 1300, costSource: 'AVG' }]);
    expect(await kartu(ON, 'REV-2')).toEqual([{ lokasiKode: 'GKERING', hargaSatuan: 1400, costSource: 'LINE' }]);
    // (34 × 1300 − 10 × 1400) / 24
    expect(await avgOf(ON, 'beras')).toBeCloseTo(1258.3333, 4);

    // Flag mati: harga kartu tetap perilaku lama, avgCost tetap dirawat bayangan.
    expect(await kartu(OFF, 'RL-1')).toEqual([{ lokasiKode: 'GKERING', hargaSatuan: 1000, costSource: 'LINE' }]);
    expect(await avgOf(OFF, 'beras')).toBeCloseTo(1258.3333, 4);
  });

  it('jurnal pemakaian RL: Dr 31020 / Cr 10310 = nilai kartu, sekali per dokumen, hanya saat flag aktif', async () => {
    const jOn = await db.collection('jurnal').find({ tenantId: ON, sourceType: 'AUTO_RL_CONSUMPTION' }).toArray();
    expect(jOn).toHaveLength(1);
    expect(jOn[0].details.map((d: { rekeningKode: string; debet: number; kredit: number }) => [d.rekeningKode, d.debet, d.kredit]))
      .toEqual([[COA.BEBAN_BAHAN.kode, 10_400, 0], [COA.PERSEDIAAN.kode, 0, 10_400]]);
    expect(await db.collection('jurnal').countDocuments({ tenantId: OFF, sourceType: 'AUTO_RL_CONSUMPTION' })).toBe(0);

    // Posting ulang (idempoten) tidak menggandakan jurnal.
    await runInTransactionOnDb(db, ({ db: txDb, session }) => postConsumptionJournal(txDb, session, {
      tenantId: ON, sourceType: 'RELEASE', sourceId: 'RL-1', noDoc: 'RL-1', tanggal: new Date(),
      lines: [{ lineRef: '1', productId: 'beras', lokasiKode: 'GKERING', deltaQtyBase: -8, qtyLokasiAfter: 0, unitCost: 1300, costSource: 'AVG', kartuId: 'x' }],
    }));
    expect(await db.collection('jurnal').countDocuments({ tenantId: ON, sourceType: 'AUTO_RL_CONSUMPTION' })).toBe(1);
  });

  it('barang jadi (memo) tanpa nilai: kartu 0, tidak ada jurnal', async () => {
    await post(ON, 'FP_RESULT', 'RES-1', [{ productId: 'nasi', warehouseKode: 'GKERING', deltaQtyBase: 20, unitCost: 5000 }]);
    await post(ON, 'RELEASE', 'RL-FG', [{ productId: 'nasi', warehouseKode: 'GKERING', deltaQtyBase: -5 }]);
    expect(await kartu(ON, 'RL-FG')).toEqual([{ lokasiKode: 'GKERING', hargaSatuan: 0, costSource: 'NON_INVENTORY' }]);
    expect(await db.collection('jurnal').countDocuments({ tenantId: ON, sourceId: 'RL-FG' })).toBe(0);
  });

  it('penyesuaian dari master produk: dinilai rata-rata dan dijurnal Persediaan vs Penyesuaian', async () => {
    const res = await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const prod = await txDb.collection('products').findOne({ tenantId: ON, id: 'beras' }, { session });
      return applyMasterProductStockChange(txDb, {
        tenantId: ON, product: prod as never, gudangKode: 'GKERING', qtyAfter: 22, session,
      });
    });
    expect(res).toMatchObject({ ok: true, qtyBefore: 24, selisih: -2 });
    const j = await db.collection('jurnal').findOne({ tenantId: ON, sourceType: 'AUTO_MASTER_PENYESUAIAN' });
    // 2 × 1258.3333 = 2516.67 → 2517
    expect(j?.details.map((d: { rekeningKode: string; debet: number; kredit: number }) => [d.rekeningKode, d.debet, d.kredit]))
      .toEqual([[COA.PENYESUAIAN.kode, 2517, 0], [COA.PERSEDIAAN.kode, 0, 2517]]);
  });

  it('migrasi 0007: replay kronologis mengisi harga kartu 0, harga historis tetap, idempoten', async () => {
    await db.collection('products').insertOne(product(OFF, 'gula', { hargaBeli: 900 }));
    const k = (i: number, sourceType: string, masuk: number, keluar: number, hargaSatuan?: number) => ({
      id: `k-gula-${i}`, tenantId: OFF, stokId: 'gula', lokasiKode: 'GKERING', sourceType, sourceId: `S${i}`, lineRef: '1',
      tanggal: new Date(`2026-09-0${i}T00:00:00Z`), createdAt: new Date(`2026-09-0${i}T00:00:00Z`), masuk, keluar,
      ...(hargaSatuan !== undefined ? { hargaSatuan } : {}),
    });
    await db.collection('stok_kartu').insertMany([
      k(3, 'RELEASE', 0, 4, 0),
      k(1, 'GRN', 10, 0, 1000),
      k(2, 'GRN', 10, 0, 1200),
      k(4, 'PENYESUAIAN', 2, 0),
    ]);
    await db.collection('stok_lokasi').insertOne({ id: 'lok-gula', tenantId: OFF, stokId: 'gula', lokasiKode: 'GKERING', qty: 18 });

    const ctx = (dryRun: boolean) => ({ db, tenantId: OFF, dryRun, now: new Date('2026-09-26T04:00:00Z'), actor: 'it' });
    const dry = await backfillStockCostMigration.run(ctx(true));
    const gulaRow = (rep: typeof dry) => (rep.after as { rows: Array<Record<string, unknown>> }).rows.find((r) => r.productId === 'gula');
    expect(gulaRow(dry)).toMatchObject({ result: 'WOULD_FILL', fill: 2, avgAfter: 1100, replayQty: 18, ledgerQty: 18, fillValue: 6600 });
    expect(await db.collection('stok_kartu').countDocuments({ stokId: 'gula', costBackfill: { $exists: true } })).toBe(0);

    await backfillStockCostMigration.run(ctx(false));
    const rows = await db.collection('stok_kartu').find({ stokId: 'gula' }).sort({ tanggal: 1 })
      .project({ _id: 0, hargaSatuan: 1, costSource: 1 }).toArray();
    expect(rows).toEqual([
      { hargaSatuan: 1000 },
      { hargaSatuan: 1200 },
      expect.objectContaining({ hargaSatuan: 1100, costSource: 'AVG' }),
      expect.objectContaining({ hargaSatuan: 1100, costSource: 'AVG' }),
    ]);
    expect(await avgOf(OFF, 'gula')).toBe(1100);

    const again = await backfillStockCostMigration.run(ctx(true));
    expect(gulaRow(again)).toBeUndefined();
  });
});
