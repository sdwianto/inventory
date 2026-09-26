import { describe, expect, it } from 'vitest';
import { calcWeightedAvgHargaBeli, reverseWeightedAvgHargaBeli } from '@/lib/api/inventory-cost';
import { grnReversalSelfApproveBlocked } from '@/lib/api/grn-reversal';

describe('reverseWeightedAvgHargaBeli', () => {
  it('membatalkan kontribusi GRN dari rata-rata tertimbang', () => {
    const after = calcWeightedAvgHargaBeli(10, 10000, 10, 14000);
    expect(after).toBe(12000);
    expect(reverseWeightedAvgHargaBeli(20, after, 10, 14000)).toBe(10000);
  });

  it('stok habis setelah pembalik: harga beli tetap', () => {
    expect(reverseWeightedAvgHargaBeli(10, 12000, 10, 12000)).toBe(12000);
    expect(reverseWeightedAvgHargaBeli(5, 12000, 10, 12000)).toBe(12000);
  });

  it('hasil tidak positif: harga beli tetap', () => {
    expect(reverseWeightedAvgHargaBeli(20, 1000, 10, 50000)).toBe(1000);
  });

  it('qty pembalik nol: harga beli tetap', () => {
    expect(reverseWeightedAvgHargaBeli(20, 12000, 0, 14000)).toBe(12000);
  });
});

describe('grnReversalSelfApproveBlocked', () => {
  const doc = { requestedBy: { userId: 'u1' } };
  it('pengaju SUPERVISOR tidak boleh menyetujui sendiri', () => {
    expect(grnReversalSelfApproveBlocked({ userId: 'u1', role: 'SUPERVISOR' }, doc)).toMatch(/tidak boleh/);
  });
  it('ADMIN/OWNER juga tidak boleh menyetujui pengajuannya sendiri', () => {
    expect(grnReversalSelfApproveBlocked({ userId: 'u1', role: 'ADMIN' }, doc)).toMatch(/tidak boleh/);
    expect(grnReversalSelfApproveBlocked({ userId: 'u1', role: 'OWNER' }, doc)).toMatch(/tidak boleh/);
  });
  it('MASTER dikecualikan (darurat, diaudit)', () => {
    expect(grnReversalSelfApproveBlocked({ userId: 'u1', isMaster: true }, doc)).toBeNull();
    expect(grnReversalSelfApproveBlocked({ userId: 'u1', role: 'MASTER', isMaster: true }, doc)).toBeNull();
  });
  it('penyetuju lain boleh', () => {
    expect(grnReversalSelfApproveBlocked({ userId: 'u2', role: 'SUPERVISOR' }, doc)).toBeNull();
  });
});
