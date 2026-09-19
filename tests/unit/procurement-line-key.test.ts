import { describe, expect, it } from 'vitest';
import {
  foldEmptySatuanMap,
  procurementLineKey,
  sameProcurementIdentity,
} from '@/lib/food-production/procurement-line-key';

describe('procurementLineKey', () => {
  it('is case-insensitive and trims kode + satuan', () => {
    expect(procurementLineKey({ kode: ' b12 ', satuan: 'ons' }))
      .toBe(procurementLineKey({ productKode: 'B12', satuan: 'ONS' }));
  });

  it('keeps different kodes and different satuan apart', () => {
    expect(procurementLineKey({ kode: 'AAA', satuan: 'KG' }))
      .not.toBe(procurementLineKey({ kode: 'BBB', satuan: 'KG' }));
    expect(procurementLineKey({ kode: 'AAA', satuan: 'KG' }))
      .not.toBe(procurementLineKey({ kode: 'AAA', satuan: 'GR' }));
  });

  it('falls back to productId when kode is missing', () => {
    expect(procurementLineKey({ productId: 'id-1', satuan: 'KG' }))
      .toBe('id:id-1::KG');
    expect(sameProcurementIdentity(
      { productId: 'id-1', satuan: 'KG' },
      { localStokId: 'id-1', satuan: 'kg' },
    )).toBe(true);
  });
});

describe('foldEmptySatuanMap', () => {
  it('folds a kode line without satuan into the only filled satuan', () => {
    const map = new Map<string, { qty: number }>([
      ['kode:SKU-X::ONS', { qty: 10 }],
      ['kode:SKU-X::', { qty: 4 }],
    ]);
    foldEmptySatuanMap(map, (a, b) => ({ qty: a.qty + b.qty }));
    expect([...map.entries()]).toEqual([['kode:SKU-X::ONS', { qty: 14 }]]);
  });

  it('does not fold when the same kode already has two satuan', () => {
    const map = new Map<string, { qty: number }>([
      ['kode:SKU-X::KG', { qty: 1 }],
      ['kode:SKU-X::GR', { qty: 2 }],
      ['kode:SKU-X::', { qty: 3 }],
    ]);
    foldEmptySatuanMap(map, (a, b) => ({ qty: a.qty + b.qty }));
    expect(map.size).toBe(3);
  });
});
