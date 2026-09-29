import { describe, expect, it } from 'vitest';
import {
  baseQtyUnitView,
  formatKartuMutasiLabel,
  formatStockDualLabel,
  productStockLabel,
  productStockTitle,
} from '@/lib/uom/display';
import type { ProductUom } from '@/lib/uom/types';

const uoms: ProductUom[] = [
  {
    id: 'u1', tenantId: 't', productId: 'p1', satuan: 'PCS',
    isBase: true, factorToBase: 1, sortOrder: 0,
    hargaEcer: 100, hargaGrosir: 90, hargaSpesial: 95, aktif: true,
  },
  {
    id: 'u2', tenantId: 't', productId: 'p1', satuan: 'BOX',
    isBase: false, factorToBase: 12, sortOrder: 1,
    hargaEcer: 1100, hargaGrosir: 1000, hargaSpesial: 1050, aktif: true,
  },
];

describe('formatStockDualLabel', () => {
  it('formats dual stock label', () => {
    expect(formatStockDualLabel(120, uoms)).toBe('120 PCS (≈ 10 BOX)');
  });

  it('single UOM returns base only', () => {
    expect(formatStockDualLabel(50, [uoms[0]])).toBe('50 PCS');
  });
});

describe('formatKartuMutasiLabel', () => {
  it('shows entered qty when same as base', () => {
    expect(formatKartuMutasiLabel({ masuk: 10, qtyEntered: 10, satuan: 'PCS' })).toBe('10 PCS');
  });

  it('shows conversion when entered differs from base', () => {
    expect(formatKartuMutasiLabel({ keluar: 120, qtyEntered: 10, satuan: 'BOX' })).toBe('10 BOX (= 120 base)');
  });
});

describe('productStockLabel', () => {
  it('prefers stokDisplay', () => {
    expect(productStockLabel({ stok: 120, stokDisplay: '120 PCS (≈ 10 BOX)' })).toBe('120 PCS (≈ 10 BOX)');
  });

  it('falls back to raw stok + satuan', () => {
    expect(productStockLabel({ stok: 5, satuan: 'DUS' })).toBe('5 DUS');
  });
});

describe('baseQtyUnitView', () => {
  const tomat: ProductUom[] = [
    { ...uoms[0], id: 'o', satuan: 'ONS' },
    { ...uoms[1], id: 'k', satuan: 'KG', factorToBase: 10 },
  ];

  it('labels lot qty with base unit and larger-unit hint', () => {
    expect(baseQtyUnitView(30, tomat, 'KG')).toEqual({
      satuan: 'ONS',
      qtyDisplay: '30 ONS (≈ 3 KG)',
      altSatuan: 'KG',
      altFactorToBase: 10,
    });
  });

  it('falls back to stored satuan without UOM rows', () => {
    expect(baseQtyUnitView(4, [], 'PCS')).toEqual({ satuan: 'PCS', qtyDisplay: '4 PCS' });
  });
});

describe('productStockTitle', () => {
  it('returns base tooltip when dual display differs', () => {
    expect(productStockTitle({ stok: 120, stokDisplay: '120 PCS (≈ 10 BOX)' })).toBe('Base: 120');
  });
});
