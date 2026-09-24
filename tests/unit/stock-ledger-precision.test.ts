import { describe, expect, it } from 'vitest';
import { isZeroQty, qtyEq, qtyGt, qtyLt, roundMoney, roundQty, roundStockQty, roundUnitCost } from '@/lib/stock-ledger';

describe('stock-ledger precision', () => {
  it('roundStockQty menghapus float dust dan -0', () => {
    expect(roundStockQty(1 - 0.9)).toBe(0.1);
    expect(roundStockQty(0.1 + 0.2)).toBe(0.3);
    expect(roundStockQty(-0.00001)).toBe(0);
    expect(Object.is(roundStockQty(-0.00001), -0)).toBe(false);
    expect(roundStockQty('2.50005')).toBe(2.5001);
    expect(roundStockQty(-2.50005)).toBe(-2.5001);
    expect(roundStockQty(undefined)).toBe(0);
    expect(roundStockQty('abc')).toBe(0);
  });

  it('pembanding qty bertoleransi', () => {
    expect(qtyLt(0.09999999999999998, 0.1)).toBe(false);
    expect(qtyLt(0.0999, 0.1)).toBe(true);
    expect(qtyGt(0.2, 0.09999999999999998)).toBe(true);
    expect(qtyEq(1 - 0.9, 0.1)).toBe(true);
    expect(isZeroQty(0.1 + 0.2 - 0.3)).toBe(true);
  });

  it('roundQty simetris untuk nilai negatif dan menerima string/null', () => {
    expect(roundQty(-2.50005)).toBe(-2.5001);
    expect(roundQty(2.50005)).toBe(2.5001);
    expect(roundQty(1 - 0.9)).toBe(0.1);
    expect(roundQty('0.30000000000000004')).toBe(0.3);
    expect(roundQty(null)).toBe(0);
    expect(roundQty(1.23456, 2)).toBe(1.23);
  });

  it('harga satuan 4 desimal, uang 2 desimal', () => {
    expect(roundUnitCost(1234.56789)).toBe(1234.5679);
    expect(roundMoney(10.005)).toBe(10.01);
  });
});
