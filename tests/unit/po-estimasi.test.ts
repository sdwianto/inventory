import { describe, expect, it } from 'vitest';
import { computeLineEstimasi, mergePoItemsByStokId, sumPoEstimasi } from '@/lib/api/po-estimasi';

describe('computeLineEstimasi', () => {
  it('computes estimasiJumlah from qty × estimasiHarga', () => {
    const row = computeLineEstimasi({ qty: 3, estimasiHarga: 11000 });
    expect(row.estimasiJumlah).toBe(33000);
  });
});

describe('mergePoItemsByStokId', () => {
  it('merges same product + same UOM', () => {
    const merged = mergePoItemsByStokId([
      { localStokId: 'p1', uomId: 'u-box', qty: 2, estimasiHarga: 10000 },
      { localStokId: 'p1', uomId: 'u-box', qty: 3, estimasiHarga: 10000 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].qty).toBe(5);
    expect(merged[0].estimasiJumlah).toBe(50000);
  });

  it('does not merge same product with different UOM', () => {
    const merged = mergePoItemsByStokId([
      { localStokId: 'p1', uomId: 'u-pcs', qty: 10, estimasiHarga: 1000 },
      { localStokId: 'p1', uomId: 'u-box', qty: 2, estimasiHarga: 10000 },
    ]);
    expect(merged).toHaveLength(2);
    expect(sumPoEstimasi(merged)).toBe(10 * 1000 + 2 * 10000);
  });

  it('merges same kode + satuan even when catalog copies and uomId differ', () => {
    const merged = mergePoItemsByStokId([
      {
        localStokId: 'copy-ani',
        kode: 'B298819',
        satuan: 'ONS',
        uomId: 'u-ani',
        qty: 14,
        estimasiHarga: 1500,
        vendorStokId: 'vs-ani',
      },
      {
        localStokId: 'copy-uddawam',
        kode: 'B298819',
        satuan: 'ons',
        uomId: 'u-uddawam',
        qty: 14,
        estimasiHarga: 1600,
        vendorStokId: 'vs-uddawam',
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].qty).toBe(28);
    expect(merged[0].kode).toBe('B298819');
    expect(merged[0].estimasiJumlah).toBe(28 * Number(merged[0].estimasiHarga));
  });

  it('keeps the priced vendor copy when merging a zero-price sibling', () => {
    const merged = mergePoItemsByStokId([
      {
        localStokId: 'copy-zero',
        kode: 'B834402',
        satuan: 'ONS',
        uomId: 'u-zero',
        qty: 19,
        estimasiHarga: 0,
        vendorStokId: 'vs-zero',
      },
      {
        localStokId: 'copy-priced',
        kode: 'B834402',
        satuan: 'ONS',
        uomId: 'u-priced',
        qty: 37,
        estimasiHarga: 3600,
        vendorStokId: 'vs-priced',
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].qty).toBe(56);
    expect(merged[0].localStokId).toBe('copy-priced');
    expect(merged[0].estimasiHarga).toBe(3600);
  });

  it('does not merge same kode with different satuan', () => {
    const merged = mergePoItemsByStokId([
      { localStokId: 'p-gr', kode: 'B001', satuan: 'GR', qty: 100, estimasiHarga: 1 },
      { localStokId: 'p-kg', kode: 'B001', satuan: 'KG', qty: 2, estimasiHarga: 1000 },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('merges any kode with catalog copies, and keeps other kodes separate', () => {
    const merged = mergePoItemsByStokId([
      { localStokId: 'a1', kode: 'SKU-AA', satuan: 'KG', qty: 2, estimasiHarga: 1000 },
      { localStokId: 'a2', kode: 'sku-aa', satuan: 'kg', uomId: 'u-other', qty: 3, estimasiHarga: 1100 },
      { localStokId: 'a3', kode: 'SKU-AA', satuan: 'KG', qty: 1, estimasiHarga: 0 },
      { localStokId: 'b1', kode: 'SKU-BB', satuan: 'KG', qty: 8, estimasiHarga: 500 },
    ]);
    expect(merged).toHaveLength(2);
    const aa = merged.find((r) => r.kode?.toString().toUpperCase() === 'SKU-AA');
    const bb = merged.find((r) => r.kode === 'SKU-BB');
    expect(aa?.qty).toBe(6);
    expect(bb?.qty).toBe(8);
  });

  it('folds a missing satuan into the only satuan of the same kode', () => {
    const merged = mergePoItemsByStokId([
      { localStokId: 'c1', kode: 'SKU-CC', satuan: 'ONS', qty: 10, estimasiHarga: 1500 },
      { localStokId: 'c2', kode: 'SKU-CC', qty: 5, estimasiHarga: 0 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].qty).toBe(15);
    expect(String(merged[0].satuan).toUpperCase()).toBe('ONS');
  });
});
