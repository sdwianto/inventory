import { describe, expect, it } from 'vitest';
import { patchQtyLineOnUomChange } from '@/lib/uom/line-patch';
import { resolveGrnReceiveLineUom } from '@/lib/uom/line-ui';
import type { ProductUom } from '@/lib/uom/types';

const ons: ProductUom = {
  id: 'u-ons',
  tenantId: 't1',
  productId: 'p1',
  satuan: 'ONS',
  isBase: true,
  factorToBase: 1,
  sortOrder: 0,
  hargaEcer: 0,
  hargaGrosir: 0,
  hargaSpesial: 0,
  aktif: true,
};

const kg: ProductUom = {
  id: 'u-kg',
  tenantId: 't1',
  productId: 'p1',
  satuan: 'KG',
  isBase: false,
  factorToBase: 10,
  sortOrder: 1,
  hargaEcer: 0,
  hargaGrosir: 0,
  hargaSpesial: 0,
  aktif: true,
};

describe('resolveGrnReceiveLineUom', () => {
  it('keeps qtyOrdered in line satuan KG (not product default ONS)', () => {
    const r = resolveGrnReceiveLineUom({
      uoms: [ons, kg],
      satuan: 'KG',
      qtyOrdered: 27,
    });
    expect(r.uom?.satuan).toBe('KG');
    expect(r.qty).toBe(27);
    expect(r.qtyBase).toBe(270);
    expect(r.factorToBase).toBe(10);
  });

  it('uses qtyBase when uomId is base but shipped label is KG', () => {
    const r = resolveGrnReceiveLineUom({
      uoms: [ons, kg],
      uomId: ons.id,
      satuan: 'KG',
      qtyOrdered: 27,
      qtyBase: 270,
    });
    expect(r.uom?.satuan).toBe('ONS');
    expect(r.qty).toBe(270);
  });

  it('converts ONS → KG keeping physical qty (27 kg)', () => {
    const init = resolveGrnReceiveLineUom({
      uoms: [ons, kg],
      satuan: 'KG',
      qtyOrdered: 27,
    });
    // Simulate user switching to ONS then back to KG
    const toOns = patchQtyLineOnUomChange(
      { qty: init.qty, factorToBase: init.factorToBase },
      ons,
    );
    expect(toOns.qty).toBe(270);
    const backToKg = patchQtyLineOnUomChange(
      { qty: toOns.qty, factorToBase: toOns.factorToBase },
      kg,
    );
    expect(backToKg.qty).toBe(27);
  });

  it('does not treat missing factor as 1 when switching from ONS default with wrong qty', () => {
    // Bug lama: qty=27 (artinya kg) + factor undefined → ganti ke KG jadi 2.7
    const broken = patchQtyLineOnUomChange({ qty: 27, factorToBase: undefined }, kg);
    expect(broken.qty).toBe(2.7);

    // Setelah fix init: qty sudah di ONS = 270 dengan factor 1
    const fixed = patchQtyLineOnUomChange({ qty: 270, factorToBase: 1 }, kg);
    expect(fixed.qty).toBe(27);
  });
});
