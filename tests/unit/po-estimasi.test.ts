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
});
