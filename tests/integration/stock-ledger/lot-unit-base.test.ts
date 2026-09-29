/**
 * Satuan lot = satuan dasar produk (qty lot selalu base), walau barang diterima / disesuaikan
 * dengan satuan lain (mis. terima 3 KG untuk produk base ONS → lot 30 ONS, bukan "30 KG").
 * Suite di-skip bila paket mongodb-memory-server tidak terpasang.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { postStockMovements } from '@/lib/stock-ledger';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-lot-unit';
const PRODUCT_IDS = ['tomat', 'tomat-adj', 'tomat-create'];
const receiver = { userId: 'u-gudang', userName: 'Penerima' } as never;

describe.skipIf(!MongoMemoryReplSet)('Satuan lot = satuan dasar (Mongo replica set)', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('lot_unit_it');
    await db.collection('stok_lokasi').createIndex({ tenantId: 1, stokId: 1, lokasiKode: 1 }, { unique: true, name: 'uniq_stok_lokasi' });
    await db.collection('products').insertMany(PRODUCT_IDS.map((id) => ({
      id, tenantId: TID, kode: id.toUpperCase(), nama: `Tomat ${id}`, satuan: 'ONS', itemRole: 'INGREDIENT', aktif: true,
      syncSource: 'local', gudangKode: 'GBASAH', hargaBeli: 1100, stok: 0,
      createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    })));
    await db.collection('product_uom').insertMany(PRODUCT_IDS.flatMap((id) => [
      { id: `ons-${id}`, tenantId: TID, productId: id, satuan: 'ONS', isBase: true, factorToBase: 1, aktif: true, sortOrder: 0 },
      { id: `kg-${id}`, tenantId: TID, productId: id, satuan: 'KG', isBase: false, factorToBase: 10, aktif: true, sortOrder: 1 },
    ]));
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it('GRN 3 KG → lot 30 ONS', async () => {
    const grn = {
      id: 'grn-unit-1', tenantId: TID, noGRN: 'GRN-UNIT-1', noDO: 'DO-UNIT-1', vendorTenantId: 'v1',
      items: [{
        lineId: 'l0', localStokId: 'tomat', vendorKode: 'TOMAT', qtyOrdered: 3, qtyBase: 30,
        satuan: 'KG', uomId: 'kg-tomat', factorToBase: 10, harga: 11000,
      }],
    };
    const res = await applyGrnStockPosting(db, TID, grn as never, [], undefined, receiver);
    expect(res.error).toBeUndefined();
    const lot = await db.collection('ingredient_lots').findOne({ tenantId: TID, grnId: grn.id });
    expect(lot?.qty).toBe(30);
    expect(lot?.satuan).toBe('ONS');
  });

  it('penyesuaian VARIANCE dengan satuan transaksi KG → lot baru ber-satuan ONS', async () => {
    const res = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'PENYESUAIAN', sourceId: 'adj-unit-1', noTransaksi: 'PS-UNIT-1', keterangan: 'hitung fisik',
      lines: [{
        lineRef: '1', productId: 'tomat-adj', warehouseKode: 'GBASAH', deltaQtyBase: 20,
        qtyEntered: 2, satuan: 'KG', binPolicy: 'NONE', lotPolicy: { mode: 'VARIANCE' },
      }],
    } as never);
    expect(res.ok).toBe(true);
    const lot = await db.collection('ingredient_lots').findOne({ tenantId: TID, productId: 'tomat-adj' });
    expect(lot?.qty).toBe(20);
    expect(lot?.satuan).toBe('ONS');
  });

  it('lotPolicy CREATE memaksa satuan dasar walau lot input membawa satuan transaksi', async () => {
    const res = await postStockMovements(db, undefined, {
      tenantId: TID, sourceType: 'PENYESUAIAN', sourceId: 'adj-unit-2', noTransaksi: 'PS-UNIT-2', keterangan: 'lot manual',
      lines: [{
        lineRef: '1', productId: 'tomat-create', warehouseKode: 'GBASAH', deltaQtyBase: 15,
        qtyEntered: 1.5, satuan: 'KG', binPolicy: 'NONE',
        lotPolicy: { mode: 'CREATE', lot: { lotNo: 'L-UNIT-2', receivedAt: '2026-09-29', expiryDate: '2026-10-29', satuan: 'KG' } },
      }],
    } as never);
    expect(res.ok).toBe(true);
    const lot = await db.collection('ingredient_lots').findOne({ tenantId: TID, lotNo: 'L-UNIT-2' });
    expect(lot?.qty).toBe(15);
    expect(lot?.satuan).toBe('ONS');
  });
});
