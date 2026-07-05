import { describe, expect, it } from 'vitest';
import { patchPoEstimasiLineOnUomChange } from '@/lib/uom/line-patch';
import type { ProductUom } from '@/lib/uom/types';

const pcs: ProductUom = {
  id: 'u-pcs', tenantId: 't1', productId: 'p1', satuan: 'PCS', isBase: true,
  factorToBase: 1, barcode: '', hargaEcer: 2140, hargaGrosir: 2000, hargaSpesial: 1900,
  sortOrder: 0, aktif: true,
};

const dus: ProductUom = {
  id: 'u-dus', tenantId: 't1', productId: 'p1', satuan: 'DUS', isBase: false,
  factorToBase: 20, barcode: '', hargaEcer: 42800, hargaGrosir: 40000, hargaSpesial: 38000,
  sortOrder: 1, aktif: true,
};

describe('patchPoEstimasiLineOnUomChange', () => {
  it('scales estimasi harga and qty when switching PCS → DUS', () => {
    const patched = patchPoEstimasiLineOnUomChange(
      { qty: 1, estimasiHarga: '2140', factorToBase: 1 },
      dus,
    );
    expect(patched.qty).toBe(0.05);
    expect(patched.estimasiHarga).toBe('42800');
    expect(patched.satuan).toBe('DUS');
  });

  it('preserves line total when switching DUS → PCS', () => {
    const patched = patchPoEstimasiLineOnUomChange(
      { qty: 1, estimasiHarga: '42800', factorToBase: 20 },
      pcs,
    );
    expect(patched.qty).toBe(20);
    expect(patched.estimasiHarga).toBe('2140');
  });
});
