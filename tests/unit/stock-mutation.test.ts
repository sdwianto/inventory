import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';

const applyLokasiDelta = vi.fn();
const recomputeProductStok = vi.fn();
const ledgerSaldoForProducts = vi.fn();
const stockPeriodLockError = vi.fn();

vi.mock('uuid', () => ({
  v4: () => 'uuid-test-1',
}));

vi.mock('@/lib/stock-ledger/balance', () => ({
  STOK_LOKASI: 'stok_lokasi',
  STOK_KARTU: 'stok_kartu',
  applyLokasiDelta: (...args: unknown[]) => applyLokasiDelta(...args),
  recomputeProductStok: (...args: unknown[]) => recomputeProductStok(...args),
}));

vi.mock('@/lib/stock-ledger/ledger-saldo', async (orig) => ({
  ...(await orig<typeof import('@/lib/stock-ledger/ledger-saldo')>()),
  ledgerSaldoForProducts: (...args: unknown[]) => ledgerSaldoForProducts(...args),
}));

vi.mock('@/lib/stock-ledger/period-guard', () => ({
  stockPeriodLockError: (...args: unknown[]) => stockPeriodLockError(...args),
}));

vi.mock('@/lib/api/stok-lokasi', () => ({
  parseLokasiKode: (v: string) => String(v || 'GKERING').toUpperCase(),
}));

vi.mock('@/lib/api/tenant-operational', () => ({
  stampTenantId: (tid: string, doc: Record<string, unknown>) => ({ ...doc, tenantId: tid }),
}));

vi.mock('@/lib/api/transaction', () => ({
  txOpts: () => ({}),
}));

const softConsumeBinOnWarehouseOut = vi.fn();
const softPutawayBinOnWarehouseIn = vi.fn();

vi.mock('@/lib/stock-ledger/bin-consume', () => ({
  softConsumeBinOnWarehouseOut: (...args: unknown[]) => softConsumeBinOnWarehouseOut(...args),
}));

vi.mock('@/lib/stock-ledger/bin-allocate', () => ({
  softPutawayBinOnWarehouseIn: (...args: unknown[]) => softPutawayBinOnWarehouseIn(...args),
}));

import { postStockMutation } from '@/lib/api/stock-mutation';

type Row = Record<string, unknown>;

function fakeDb(state: { products: Row[]; lokasi: Row[]; kartu: Row[] }): Db {
  return {
    collection: (name: string) => ({
      find: () => ({
        project: () => ({
          toArray: async () => (name === 'products' ? state.products : name === 'stok_lokasi' ? state.lokasi : []),
        }),
      }),
      findOne: async () => null,
      insertMany: async (docs: Row[]) => {
        state.kartu.push(...docs);
        return { insertedCount: docs.length };
      },
    }),
  } as unknown as Db;
}

describe('postStockMutation → postStockMovements', () => {
  let state: { products: Row[]; lokasi: Row[]; kartu: Row[] };
  let db: Db;

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      products: [
        { id: 'p1', kode: 'P1', nama: 'Produk 1', gudangKode: 'GKERING', hargaBeli: 700 },
        { id: 'p2', kode: 'P2', nama: 'Produk 2', gudangKode: 'GBASAH', hargaBeli: 0 },
      ],
      lokasi: [{ stokId: 'p1', lokasiKode: 'GKERING', qty: 20 }, { stokId: 'p2', lokasiKode: 'GBASAH', qty: 8 }],
      kartu: [],
    };
    db = fakeDb(state);
    applyLokasiDelta.mockResolvedValue({ qty: 15 });
    recomputeProductStok.mockResolvedValue(15);
    ledgerSaldoForProducts.mockResolvedValue(new Map());
    stockPeriodLockError.mockResolvedValue(null);
    softConsumeBinOnWarehouseOut.mockResolvedValue({ allocated: 0, shortfall: 0, skippedNoBins: true, takes: [] });
    softPutawayBinOnWarehouseIn.mockResolvedValue({ allocated: 0, skippedNoDefaultBin: true });
  });

  const base = {
    tenantId: 't1',
    productId: 'p1',
    warehouseKode: 'GKERING',
    sourceType: 'FP_RESULT',
    sourceId: 'hsl-1',
    noTransaksi: 'HSL-001',
    keterangan: 'Hasil produksi',
  };

  it('rejects zero / invalid delta tanpa menulis', async () => {
    const r = await postStockMutation(db, { ...base, deltaQtyBase: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/tidak valid/i);
    const dust = await postStockMutation(db, { ...base, deltaQtyBase: 0.00000001 });
    expect(dust.ok).toBe(false);
    expect(applyLokasiDelta).not.toHaveBeenCalled();
  });

  it('requires productId and noTransaksi', async () => {
    const r = await postStockMutation(db, { ...base, productId: '', noTransaksi: '', deltaQtyBase: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/wajib/i);
  });

  it('masuk: update lokasi, putaway bin, kartu dengan harga baris', async () => {
    softPutawayBinOnWarehouseIn.mockResolvedValue({ allocated: 10, binKode: 'RCV', skippedNoDefaultBin: false });
    const r = await postStockMutation(db, { ...base, deltaQtyBase: 10, hargaSatuan: 1000 });
    expect(r).toEqual({ ok: true, qtyAfter: 15, lokasiKode: 'GKERING', kartuId: 'uuid-test-1' });
    expect(applyLokasiDelta).toHaveBeenCalledWith(db, 't1', 'p1', 'GKERING', 10, expect.any(Date), undefined);
    expect(softConsumeBinOnWarehouseOut).not.toHaveBeenCalled();
    expect(softPutawayBinOnWarehouseIn).toHaveBeenCalledWith(db, 't1', 'p1', 'GKERING', 10, undefined);
    expect(state.kartu[0]).toMatchObject({
      tenantId: 't1',
      stokId: 'p1',
      noTransaksi: 'HSL-001',
      sourceType: 'FP_RESULT',
      lineRef: 'p1',
      masuk: 10,
      keluar: 0,
      hargaSatuan: 1000,
      costSource: 'LINE',
      binKode: 'RCV',
      lokasiKode: 'GKERING',
    });
  });

  it('keluar tanpa harga memakai rata-rata produk dan konsumsi bin', async () => {
    const r = await postStockMutation(db, { ...base, deltaQtyBase: -3, sourceType: 'FP_ISSUE', noTransaksi: 'PBL-001' });
    expect(r.ok).toBe(true);
    expect(softConsumeBinOnWarehouseOut).toHaveBeenCalledWith(db, 't1', 'p1', 'GKERING', 3, undefined);
    expect(softPutawayBinOnWarehouseIn).not.toHaveBeenCalled();
    expect(state.kartu[0]).toMatchObject({ masuk: 0, keluar: 3, hargaSatuan: 700, costSource: 'PRODUCT_AVG' });
  });

  it('stok kurang: gagal sebelum menulis lokasi, kartu, atau bin', async () => {
    const r = await postStockMutation(db, { ...base, deltaQtyBase: -99, sourceType: 'FP_ISSUE' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('tidak cukup');
    expect(applyLokasiDelta).not.toHaveBeenCalled();
    expect(state.kartu).toHaveLength(0);
    expect(softConsumeBinOnWarehouseOut).not.toHaveBeenCalled();
  });

  it('toleransi float dust: keluar 0.1 dari 0.0999… lolos pre-check', async () => {
    state.lokasi[0].qty = 1 - 0.9;
    const r = await postStockMutation(db, { ...base, deltaQtyBase: -0.1, sourceType: 'PENYESUAIAN' });
    expect(r.ok).toBe(true);
    expect(applyLokasiDelta).toHaveBeenCalledWith(db, 't1', 'p1', 'GKERING', -0.1, expect.any(Date), undefined);
  });

  it('saldo kartu membatasi keluar untuk sumber operasional', async () => {
    ledgerSaldoForProducts.mockResolvedValue(new Map([['p1', { saldo: 2, hasActivity: true }]]));
    const r = await postStockMutation(db, { ...base, deltaQtyBase: -5, sourceType: 'RELEASE' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('saldo kartu');
    expect(applyLokasiDelta).not.toHaveBeenCalled();
  });

  it('guard atomik gagal (race): error, tanpa kartu', async () => {
    applyLokasiDelta.mockResolvedValue({ error: 'Stok di lokasi GKERING tidak cukup', current: 1 });
    const r = await postStockMutation(db, { ...base, deltaQtyBase: -2, sourceType: 'FP_ISSUE' });
    expect(r.ok).toBe(false);
    expect(state.kartu).toHaveLength(0);
  });

  it('shortfall bin tetap ok:true', async () => {
    softConsumeBinOnWarehouseOut.mockResolvedValueOnce({ allocated: 0, shortfall: 2, skippedNoBins: true, takes: [] });
    const r = await postStockMutation(db, { ...base, deltaQtyBase: -2, sourceType: 'RELEASE', noTransaksi: 'REL-1' });
    expect(r.ok).toBe(true);
  });

  it('gudang bukan home produk ditolak', async () => {
    const r = await postStockMutation(db, { ...base, warehouseKode: 'GBASAH', deltaQtyBase: 1 });
    expect(r.ok).toBe(false);
    expect(applyLokasiDelta).not.toHaveBeenCalled();
  });

  it('periode terkunci ditolak', async () => {
    stockPeriodLockError.mockResolvedValue('Periode akuntansi terkunci');
    const r = await postStockMutation(db, { ...base, deltaQtyBase: 1 });
    expect(r).toEqual({ ok: false, error: 'Periode akuntansi terkunci' });
  });
});
