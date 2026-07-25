import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';

const ensureStokLokasiRow = vi.fn(async () => ({}));
const adjustStokLokasi = vi.fn(async () => ({ qtyAfter: 15 }));
const syncProductStokFromLokasi = vi.fn(async () => 15);
const parseLokasiKode = vi.fn((v: string) => String(v || 'GKERING').toUpperCase());

vi.mock('uuid', () => ({
  v4: () => 'uuid-test-1',
}));

vi.mock('@/lib/api/stok-lokasi', () => ({
  ensureStokLokasiRow: (...args: unknown[]) => ensureStokLokasiRow(...args),
  adjustStokLokasi: (...args: unknown[]) => adjustStokLokasi(...args),
  syncProductStokFromLokasi: (...args: unknown[]) => syncProductStokFromLokasi(...args),
  parseLokasiKode: (...args: unknown[]) => parseLokasiKode(...(args as [string])),
}));

vi.mock('@/lib/api/warehouses', () => ({
  warehouseLabel: (kode: string) => (kode === 'GBASAH' ? 'Basah' : 'Kering'),
}));

vi.mock('@/lib/api/tenant-operational', () => ({
  stampTenantId: (tid: string, doc: Record<string, unknown>) => ({ ...doc, tenantId: tid }),
}));

vi.mock('@/lib/api/transaction', () => ({
  txOpts: () => ({}),
}));

const softConsumeBinOnWarehouseOut = vi.fn(async () => ({
  allocated: 0,
  shortfall: 0,
  skippedNoBins: true,
  takes: [],
}));

const softPutawayBinOnWarehouseIn = vi.fn(async () => ({
  allocated: 0,
  skippedNoDefaultBin: true,
}));

vi.mock('@/lib/api/stok-bin-consume', () => ({
  softConsumeBinOnWarehouseOut: (...args: unknown[]) => softConsumeBinOnWarehouseOut(...args),
}));

vi.mock('@/lib/api/stok-bin-allocate', () => ({
  softPutawayBinOnWarehouseIn: (...args: unknown[]) => softPutawayBinOnWarehouseIn(...args),
}));

import { postStockMutation } from '@/lib/api/stock-mutation';

describe('postStockMutation', () => {
  let inserted: Record<string, unknown> | null;
  let db: Db;

  beforeEach(() => {
    inserted = null;
    ensureStokLokasiRow.mockClear();
    adjustStokLokasi.mockClear();
    syncProductStokFromLokasi.mockClear();
    parseLokasiKode.mockClear();
    softConsumeBinOnWarehouseOut.mockClear();
    softPutawayBinOnWarehouseIn.mockClear();
    adjustStokLokasi.mockResolvedValue({ qtyAfter: 15 });
    syncProductStokFromLokasi.mockResolvedValue(15);
    softConsumeBinOnWarehouseOut.mockResolvedValue({
      allocated: 0,
      shortfall: 0,
      skippedNoBins: true,
      takes: [],
    });
    softPutawayBinOnWarehouseIn.mockResolvedValue({
      allocated: 0,
      skippedNoDefaultBin: true,
    });

    db = {
      collection: () => ({
        insertOne: async (doc: Record<string, unknown>) => {
          inserted = doc;
          return { insertedId: 'x' };
        },
      }),
    } as unknown as Db;
  });

  it('rejects zero / invalid delta', async () => {
    const r = await postStockMutation(db, {
      tenantId: 't1',
      productId: 'p1',
      warehouseKode: 'GKERING',
      deltaQtyBase: 0,
      sourceType: 'FP_ADJUST',
      noTransaksi: 'ADJ-1',
      keterangan: 'noop',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/tidak valid/i);
    expect(ensureStokLokasiRow).not.toHaveBeenCalled();
  });

  it('requires productId and noTransaksi', async () => {
    const r = await postStockMutation(db, {
      tenantId: 't1',
      productId: '',
      warehouseKode: 'GKERING',
      deltaQtyBase: 5,
      sourceType: 'FP_RESULT',
      noTransaksi: '',
      keterangan: 'hasil',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/wajib/i);
  });

  it('posts masuk ledger when delta positive', async () => {
    const r = await postStockMutation(db, {
      tenantId: 't1',
      productId: 'p1',
      warehouseKode: 'GKERING',
      deltaQtyBase: 10,
      sourceType: 'FP_RESULT',
      noTransaksi: 'HSL-001',
      keterangan: 'Hasil produksi',
      hargaSatuan: 1000,
    });
    expect(r).toEqual({ ok: true, qtyAfter: 15, lokasiKode: 'GKERING' });
    expect(ensureStokLokasiRow).toHaveBeenCalled();
    expect(adjustStokLokasi).toHaveBeenCalledWith(db, 't1', 'p1', 'GKERING', 10, undefined);
    expect(softConsumeBinOnWarehouseOut).not.toHaveBeenCalled();
    expect(softPutawayBinOnWarehouseIn).toHaveBeenCalledWith(
      db,
      't1',
      'p1',
      'GKERING',
      10,
      undefined,
    );
    expect(inserted).toMatchObject({
      tenantId: 't1',
      stokId: 'p1',
      noTransaksi: 'HSL-001',
      sourceType: 'FP_RESULT',
      masuk: 10,
      keluar: 0,
      hargaSatuan: 1000,
      lokasiKode: 'GKERING',
    });
  });

  it('posts keluar ledger when delta negative', async () => {
    adjustStokLokasi.mockResolvedValue({ qtyAfter: 5 });
    syncProductStokFromLokasi.mockResolvedValue(5);

    const r = await postStockMutation(db, {
      tenantId: 't1',
      productId: 'p1',
      warehouseKode: 'GBASAH',
      deltaQtyBase: -3,
      sourceType: 'FP_ISSUE',
      noTransaksi: 'PBL-001',
      keterangan: 'Issue bahan',
    });
    expect(r).toEqual({ ok: true, qtyAfter: 5, lokasiKode: 'GBASAH' });
    expect(softConsumeBinOnWarehouseOut).toHaveBeenCalledWith(
      db,
      't1',
      'p1',
      'GBASAH',
      3,
      undefined,
    );
    expect(softPutawayBinOnWarehouseIn).not.toHaveBeenCalled();
    expect(inserted).toMatchObject({
      sourceType: 'FP_ISSUE',
      masuk: 0,
      keluar: 3,
      lokasiKode: 'GBASAH',
    });
  });

  it('returns adjust error without writing kartu or consuming bins', async () => {
    adjustStokLokasi.mockResolvedValue({ error: 'Stok tidak cukup' });
    const r = await postStockMutation(db, {
      tenantId: 't1',
      productId: 'p1',
      warehouseKode: 'GKERING',
      deltaQtyBase: -99,
      sourceType: 'FP_ISSUE',
      noTransaksi: 'PBL-X',
      keterangan: 'kurang',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Stok tidak cukup');
    expect(inserted).toBeNull();
    expect(softConsumeBinOnWarehouseOut).not.toHaveBeenCalled();
    expect(softPutawayBinOnWarehouseIn).not.toHaveBeenCalled();
  });

  it('keeps ok:true when soft bin consume returns shortfall', async () => {
    adjustStokLokasi.mockResolvedValue({ qtyAfter: 5 });
    syncProductStokFromLokasi.mockResolvedValue(5);
    softConsumeBinOnWarehouseOut.mockResolvedValueOnce({
      allocated: 0,
      shortfall: 2,
      skippedNoBins: true,
      takes: [],
    });

    const r = await postStockMutation(db, {
      tenantId: 't1',
      productId: 'p1',
      warehouseKode: 'GKERING',
      deltaQtyBase: -2,
      sourceType: 'RELEASE',
      noTransaksi: 'REL-1',
      keterangan: 'out',
    });
    expect(r).toEqual({ ok: true, qtyAfter: 5, lokasiKode: 'GKERING' });
    expect(softConsumeBinOnWarehouseOut).toHaveBeenCalledWith(
      db,
      't1',
      'p1',
      'GKERING',
      2,
      undefined,
    );
  });
});
