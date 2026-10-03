/**
 * Faktur pajak keluaran vendor → hutang: urutan event acak, duplikat, ganti, batal, hutang yang dibuat belakangan.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import {
  VENDOR_FAKTUR_PAJAK_COLLECTION,
  applyVendorFakturPajakEvent,
  ingestInvoiceFakturPajak,
} from '@/lib/api/vendor-faktur-pajak';

type ReplSet = { getUri(): string; stop(): Promise<boolean> };

let MongoMemoryReplSet: { create(opts: unknown): Promise<ReplSet> } | null = null;
try {
  ({ MongoMemoryReplSet } = await import('mongodb-memory-server'));
} catch {
  MongoMemoryReplSet = null;
}

const TID = 'it-faktur';
const VENDOR = 'vendor-a';

function evt(over: Record<string, unknown> = {}) {
  return {
    customerTenantId: TID,
    vendorTenantId: VENDOR,
    fakturId: 'f-1',
    invoiceId: 'inv-1',
    noInvoice: 'INV-1',
    status: 'DISETUJUI',
    aktif: true,
    nomorFaktur: '0400002612345678',
    pengganti: false,
    replacesId: null,
    nomorDiganti: null,
    tanggal: '2026-10-02T03:00:00.000Z',
    masa: '2026-10',
    trxCode: '04',
    ppnRate: 11,
    dpp: 100000,
    dppLain: 91666.67,
    ppn: 11000,
    updatedAt: '2026-10-02T04:00:00.000Z',
    ...over,
  };
}

describe.skipIf(!MongoMemoryReplSet)('vendor faktur pajak → hutang', { timeout: 120_000 }, () => {
  let rs: ReplSet;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet!.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
    client = await MongoClient.connect(rs.getUri());
    db = client.db('vendor_faktur_it');
    await db.collection(VENDOR_FAKTUR_PAJAK_COLLECTION).createIndex(
      { tenantId: 1, vendorTenantId: 1, fakturId: 1 },
      { unique: true },
    );
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  beforeEach(async () => {
    await db.collection(VENDOR_FAKTUR_PAJAK_COLLECTION).deleteMany({});
    await db.collection('hutang').deleteMany({});
    await db.collection('hutang').insertMany([
      { id: 'h-1', tenantId: TID, vendorInvoiceId: 'inv-1', referenceType: 'VENDOR_INVOICE', vendorTenantId: VENDOR, ppn: 11000 },
      { id: 'h-x', tenantId: TID, vendorInvoiceId: 'inv-1', referenceType: 'VENDOR_INVOICE', vendorTenantId: 'vendor-b', ppn: 0 },
    ]);
  });

  const hutang = (id = 'h-1') => db.collection('hutang').findOne({ id });

  it('nomor faktur tersalin ke hutang vendor yang benar saja', async () => {
    const r = await applyVendorFakturPajakEvent(db, TID, evt(), VENDOR);
    expect(r).toMatchObject({ message: 'faktur_pajak_applied', hutangUpdated: true, activeStatus: 'DISETUJUI' });
    expect((await hutang())?.fakturPajak).toMatchObject({ fakturId: 'f-1', status: 'DISETUJUI', nomorFaktur: '0400002612345678' });
    expect((await hutang('h-x'))?.fakturPajak).toBeUndefined();
  });

  it('event lama atau duplikat tidak menimpa status yang lebih baru', async () => {
    await applyVendorFakturPajakEvent(db, TID, evt(), VENDOR);
    const stale = await applyVendorFakturPajakEvent(
      db, TID, evt({ status: 'DRAFT', nomorFaktur: null, updatedAt: '2026-10-02T03:30:00.000Z' }), VENDOR,
    );
    expect(stale.message).toBe('faktur_pajak_stale');
    const dup = await applyVendorFakturPajakEvent(db, TID, evt(), VENDOR);
    expect(dup.message).toBe('faktur_pajak_stale');
    expect((await hutang())?.fakturPajak?.status).toBe('DISETUJUI');
    expect(await db.collection(VENDOR_FAKTUR_PAJAK_COLLECTION).countDocuments({})).toBe(1);
  });

  it('ganti faktur: pengganti aktif menang walau event faktur lama datang belakangan', async () => {
    await applyVendorFakturPajakEvent(db, TID, evt(), VENDOR);
    await applyVendorFakturPajakEvent(db, TID, evt({
      fakturId: 'f-2', status: 'DRAFT', nomorFaktur: null, pengganti: true, replacesId: 'f-1',
      nomorDiganti: '0400002612345678', updatedAt: '2026-10-03T01:00:00.000Z',
    }), VENDOR);
    await applyVendorFakturPajakEvent(db, TID, evt({
      status: 'DIGANTI', aktif: false, updatedAt: '2026-10-03T01:00:00.000Z',
    }), VENDOR);
    expect((await hutang())?.fakturPajak).toMatchObject({ fakturId: 'f-2', status: 'DRAFT', pengganti: true, nomorFaktur: null });

    await applyVendorFakturPajakEvent(db, TID, evt({
      fakturId: 'f-2', status: 'DISETUJUI', nomorFaktur: '0400002699999999', pengganti: true, replacesId: 'f-1',
      updatedAt: '2026-10-03T02:00:00.000Z',
    }), VENDOR);
    expect((await hutang())?.fakturPajak).toMatchObject({ fakturId: 'f-2', nomorFaktur: '0400002699999999' });
  });

  it('faktur batal: hutang menampilkan status BATAL (tidak ada faktur aktif)', async () => {
    await applyVendorFakturPajakEvent(db, TID, evt(), VENDOR);
    await applyVendorFakturPajakEvent(db, TID, evt({ status: 'BATAL', aktif: false, updatedAt: '2026-10-04T00:00:00.000Z' }), VENDOR);
    expect((await hutang())?.fakturPajak).toMatchObject({ status: 'BATAL', aktif: false });
  });

  it('event sebelum hutang ada tersimpan, lalu tersalin saat hutang dibuat', async () => {
    await db.collection('hutang').deleteMany({ id: 'h-1' });
    const r = await applyVendorFakturPajakEvent(db, TID, evt(), VENDOR);
    expect(r.hutangUpdated).toBe(false);
    await db.collection('hutang').insertOne({ id: 'h-1', tenantId: TID, vendorInvoiceId: 'inv-1', referenceType: 'VENDOR_INVOICE', vendorTenantId: VENDOR });
    await ingestInvoiceFakturPajak(db, TID, VENDOR, 'inv-1', undefined);
    expect((await hutang())?.fakturPajak?.nomorFaktur).toBe('0400002612345678');
  });

  it('faktur di payload invoice ikut disimpan; snapshot lama tidak menimpa event lebih baru', async () => {
    await applyVendorFakturPajakEvent(db, TID, evt(), VENDOR);
    await ingestInvoiceFakturPajak(db, TID, VENDOR, 'inv-1', {
      ...evt({ status: 'DRAFT', nomorFaktur: null, updatedAt: '2026-10-02T03:00:00.000Z' }),
    });
    expect((await hutang())?.fakturPajak?.status).toBe('DISETUJUI');
    await ingestInvoiceFakturPajak(db, TID, VENDOR, 'inv-lain', evt());
    expect(await db.collection(VENDOR_FAKTUR_PAJAK_COLLECTION).countDocuments({ invoiceId: 'inv-lain' })).toBe(0);
  });

  it('event paralel tidak meninggalkan ringkasan basi di hutang', async () => {
    const events = [
      evt({ status: 'DRAFT', nomorFaktur: null, updatedAt: '2026-10-02T03:00:00.000Z' }),
      evt(),
      evt({ status: 'DIGANTI', aktif: false, updatedAt: '2026-10-03T01:00:00.000Z' }),
      evt({ fakturId: 'f-2', status: 'DRAFT', nomorFaktur: null, pengganti: true, replacesId: 'f-1', updatedAt: '2026-10-03T01:00:00.000Z' }),
      evt({ fakturId: 'f-2', status: 'DISETUJUI', nomorFaktur: '0400002699999999', pengganti: true, replacesId: 'f-1', updatedAt: '2026-10-03T02:00:00.000Z' }),
    ];
    for (let round = 0; round < 10; round++) {
      await db.collection(VENDOR_FAKTUR_PAJAK_COLLECTION).deleteMany({});
      await db.collection('hutang').updateOne({ id: 'h-1' }, { $unset: { fakturPajak: '', fakturPajakRev: '' } });
      const shuffled = [...events].sort(() => Math.random() - 0.5);
      await Promise.all(shuffled.map((e) => applyVendorFakturPajakEvent(db, TID, e, VENDOR)));
      expect((await hutang())?.fakturPajak).toMatchObject({ fakturId: 'f-2', status: 'DISETUJUI', nomorFaktur: '0400002699999999' });
    }
  });

  it('hutang lama tanpa vendorTenantId tetap menerima faktur; hutang vendor lain tidak', async () => {
    await db.collection('hutang').deleteMany({});
    await db.collection('hutang').insertMany([
      { id: 'h-legacy', tenantId: TID, vendorInvoiceId: 'inv-1', referenceType: 'VENDOR_INVOICE' },
      { id: 'h-x', tenantId: TID, vendorInvoiceId: 'inv-1', referenceType: 'VENDOR_INVOICE', vendorTenantId: 'vendor-b' },
    ]);
    const r = await applyVendorFakturPajakEvent(db, TID, evt(), VENDOR);
    expect(r.hutangUpdated).toBe(true);
    expect((await hutang('h-legacy'))?.fakturPajak?.nomorFaktur).toBe('0400002612345678');
    expect((await hutang('h-x'))?.fakturPajak).toBeUndefined();
  });

  it('menolak event tanpa vendor terverifikasi atau payload tidak valid', async () => {
    await expect(applyVendorFakturPajakEvent(db, TID, evt(), null)).rejects.toThrow(/vendorTenantId/);
    await expect(applyVendorFakturPajakEvent(db, TID, evt({ nomorFaktur: null }), VENDOR)).rejects.toThrow(/tidak valid/);
  });
});
