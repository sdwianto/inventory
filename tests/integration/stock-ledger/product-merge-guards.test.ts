/**
 * Fase 2 — penjaga item kanonik: kode aktif + nonaktif, reaktivasi yang bentrok index unik,
 * dan pemindahan saldo negatif / cadangan saat gabung stok.
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { mergeProductStock } from '@/lib/stock-ledger';
import {
  PRODUCT_KODE_UNIQUE_FILTER,
  PRODUCT_KODE_UNIQUE_INDEX,
  findKodeCanonical,
  findKodeCanonicalBatch,
  refreshCanonicalAktif,
} from '@/lib/api/product-merge';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-f2-guard';

const product = (id: string, kode: string, extra: Record<string, unknown> = {}) => ({
  id, tenantId: TID, kode, nama: `Produk ${kode}`, satuan: 'KG', aktif: true, mergedInto: null,
  syncSource: 'sales.app', vendorTenantId: 'v1', vendorStokId: `vs-${id}`, vendorAktif: true, stok: 0,
  ...extra,
});

describe.skipIf(!MongoMemoryReplSet)('Fase 2 penjaga item kanonik', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('product_merge_guard_it');
    await db.collection('products').createIndex(
      { tenantId: 1, kode: 1 },
      { name: PRODUCT_KODE_UNIQUE_INDEX, unique: true, partialFilterExpression: PRODUCT_KODE_UNIQUE_FILTER },
    );
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('kode dengan satu aktif + nonaktif: item aktif jadi kanonik', async () => {
    await db.collection('products').insertMany([
      product('ab-old', 'AB01', { aktif: false, vendorAktif: false }),
      product('ab-new', 'AB01'),
    ]);
    expect((await findKodeCanonical(db, TID, 'AB01'))?.id).toBe('ab-new');
    expect((await findKodeCanonicalBatch(db, TID, ['AB01'])).get('AB01')?.id).toBe('ab-new');
  });

  it('reaktivasi kanonik yang bentrok kode aktif lain tidak melempar error dan tetap nonaktif', async () => {
    await db.collection('products').insertMany([
      product('cd-canon', 'CD01', { aktif: false, vendorAktif: false }),
      product('cd-local', 'CD01', { syncSource: 'local', vendorTenantId: null, vendorStokId: null }),
      product('cd-copy', 'CD01', { vendorTenantId: 'v2', mergedInto: 'cd-canon' }),
    ]);
    await expect(refreshCanonicalAktif(db, TID, ['cd-canon'])).resolves.toBe(0);
    const canon = await db.collection('products').findOne({ id: 'cd-canon' });
    expect(canon?.aktif).toBe(false);
  });

  it('gabung stok memindah saldo negatif dan cadangan walau baris target belum ada', async () => {
    await db.collection('stok_lokasi').insertMany([
      { tenantId: TID, stokId: 'ef-src', lokasiKode: 'GKERING', qty: -2 },
      { tenantId: TID, stokId: 'ef-src', lokasiKode: 'GBASAH', qty: 0, qtyReserved: 1.5 },
      { tenantId: TID, stokId: 'ef-dst', lokasiKode: 'GKERING', qty: 5 },
    ]);
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await mergeProductStock(db, session, { tenantId: TID, fromId: 'ef-src', toId: 'ef-dst', now: new Date() });
      });
    } finally {
      await session.endSession();
    }
    const rows = await db.collection('stok_lokasi').find({ tenantId: TID, stokId: 'ef-dst' }).toArray();
    const by = new Map(rows.map((r) => [r.lokasiKode, r]));
    expect(by.get('GKERING')?.qty).toBe(3);
    expect(by.get('GBASAH')?.qtyReserved).toBe(1.5);
    expect(await db.collection('stok_lokasi').countDocuments({ tenantId: TID, stokId: 'ef-src' })).toBe(0);
  });
});
