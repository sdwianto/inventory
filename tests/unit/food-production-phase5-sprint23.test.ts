import { describe, expect, it } from 'vitest';
import {
  normalizeHargaBeliBook,
  isPriceBookEffective,
  pickBestBookPrices,
} from '@/lib/food-production/supplier-price-book';
import { pickLocalProductId } from '@/lib/api/supplier-price-book-from-invoice';
import { recommendCheaperSupply } from '@/lib/food-production/recommendations';

describe('food-production phase 5 sprint 23', () => {
  it('normalizes harga and effective window', () => {
    expect(normalizeHargaBeliBook('12.345')).toBe(12.35);
    expect(normalizeHargaBeliBook(0)).toEqual({ error: expect.stringMatching(/harga/) });
    expect(isPriceBookEffective({ aktif: true, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }, '2026-07-01')).toBe(true);
    expect(isPriceBookEffective({ aktif: true, effectiveFrom: '2026-08-01' }, '2026-07-01')).toBe(false);
    expect(isPriceBookEffective({ aktif: false }, '2026-07-01')).toBe(false);
  });

  it('picks lowest active book price per product', () => {
    const best = pickBestBookPrices([
      { productId: 'p1', harga: 100, supplierId: 's1', supplierNama: 'A', aktif: true },
      { productId: 'p1', harga: 80, supplierId: 's2', supplierNama: 'B', aktif: true },
      { productId: 'p1', harga: 50, supplierId: 's3', supplierNama: 'C', aktif: false },
      { productId: 'p2', harga: 10, supplierId: 's1', aktif: true },
    ]);
    expect(best.get('p1')?.harga).toBe(80);
    expect(best.get('p1')?.supplierId).toBe('s2');
    expect(best.get('p2')?.harga).toBe(10);
  });

  it('CHEAPER_SUPPLY prefers price book over GRN when both qualify', () => {
    const recs = recommendCheaperSupply({
      products: [{
        productId: 'beras',
        productNama: 'Beras',
        hargaBeli: 13000,
        lastReceiptUnitPrice: 10000,
        bestBookPrice: 9000,
        bestBookSupplierId: 's1',
        bestBookSupplierNama: 'Supplier Hemat',
      }],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].type).toBe('CHEAPER_SUPPLY');
    expect(recs[0].evidence?.source).toBe('book');
    expect(recs[0].href).toBe('/food-production/price-book');
    expect(String(recs[0].detail)).toMatch(/price book/);
  });

  it('invoice sync resolves local product id (not vendor stokId alone)', () => {
    expect(pickLocalProductId({ stokId: 'vendor-sku' }, { localStokId: 'local-p1' })).toBe('local-p1');
    expect(pickLocalProductId({ localStokId: 'local-p2', stokId: 'v' })).toBe('local-p2');
    expect(pickLocalProductId({ stokId: 'vendor-only' })).toBe('');
  });

  it('CHEAPER_SUPPLY still works with GRN-only signal', () => {
    const recs = recommendCheaperSupply({
      products: [{
        productId: 'beras',
        productNama: 'Beras',
        hargaBeli: 13000,
        lastReceiptUnitPrice: 10000,
      }],
    });
    expect(recs[0]?.evidence?.source).toBe('grn');
  });
});
