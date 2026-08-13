import { describe, expect, it } from 'vitest';
import { patchQtyLineOnUomChange } from '@/lib/uom/line-patch';
import { reconcileLineQtyBase, resolveGrnReceiveLineUom } from '@/lib/uom/line-ui';
import type { ProductUom } from '@/lib/uom/types';

function uom(partial: Partial<ProductUom> & Pick<ProductUom, 'id' | 'satuan' | 'isBase' | 'factorToBase'>): ProductUom {
  return {
    tenantId: 't1',
    productId: 'p1',
    sortOrder: 0,
    hargaEcer: 0,
    hargaGrosir: 0,
    hargaSpesial: 0,
    aktif: true,
    ...partial,
  };
}

const ons = uom({ id: 'u-ons', satuan: 'ONS', isBase: true, factorToBase: 1 });
const kg = uom({ id: 'u-kg', satuan: 'KG', isBase: false, factorToBase: 10, sortOrder: 1 });
const pcs = uom({ id: 'u-pcs', satuan: 'PCS', isBase: true, factorToBase: 1 });
const box = uom({ id: 'u-box', satuan: 'BOX', isBase: false, factorToBase: 12, sortOrder: 1 });
const ikat = uom({ id: 'u-ikat', satuan: 'IKAT', isBase: true, factorToBase: 1 });

describe('reconcileLineQtyBase', () => {
  it('ignores webhook qtyBase that equals qtyOrdered (wrong base)', () => {
    expect(reconcileLineQtyBase({ qtyOrdered: 27, orderedFactor: 10, qtyBaseHint: 27 })).toBe(270);
  });

  it('keeps consistent qtyBase', () => {
    expect(reconcileLineQtyBase({ qtyOrdered: 27, orderedFactor: 10, qtyBaseHint: 270 })).toBe(270);
  });

  it('works for any factor (BOX ×12, not only KG ×10)', () => {
    expect(reconcileLineQtyBase({ qtyOrdered: 5, orderedFactor: 12, qtyBaseHint: 5 })).toBe(60);
    expect(reconcileLineQtyBase({ qtyOrdered: 5, orderedFactor: 12, qtyBaseHint: 60 })).toBe(60);
  });
});

describe('resolveGrnReceiveLineUom — berlaku umum', () => {
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

  it('fixes bad qtyBase=qtyOrdered when satuan is KG (x10)', () => {
    const r = resolveGrnReceiveLineUom({
      uoms: [ons, kg],
      satuan: 'KG',
      uomId: kg.id,
      qtyOrdered: 27,
      qtyBase: 27,
      factorToBase: 10,
    });
    expect(r.uom?.satuan).toBe('KG');
    expect(r.qty).toBe(27);
    expect(r.qtyBase).toBe(270);
  });

  it('KG lines: qty = qtyOrdered even when GRN qtyBase & factorToBase wrong', () => {
    for (const qtyOrdered of [27, 42, 3.5, 100]) {
      const r = resolveGrnReceiveLineUom({
        uoms: [ons, kg],
        satuan: 'KG',
        uomId: kg.id,
        qtyOrdered,
        qtyBase: qtyOrdered,
        factorToBase: 1,
      });
      expect(r.uom?.satuan).toBe('KG');
      expect(r.qty).toBe(qtyOrdered);
      expect(r.qtyBase).toBe(qtyOrdered * 10);
      expect(r.factorToBase).toBe(10);
    }
  });

  it('BOX ×12: qty kirim tetap di BOX meski qtyBase webhook salah', () => {
    const r = resolveGrnReceiveLineUom({
      uoms: [pcs, box],
      satuan: 'BOX',
      qtyOrdered: 5,
      qtyBase: 5,
      factorToBase: 1,
    });
    expect(r.uom?.satuan).toBe('BOX');
    expect(r.qty).toBe(5);
    expect(r.qtyBase).toBe(60);
  });

  it('base-only (PCS / IKAT): qty = qtyOrdered, factor 1', () => {
    for (const [list, sat, qty] of [
      [[pcs], 'PCS', 100],
      [[ikat], 'IKAT', 8],
    ] as const) {
      const r = resolveGrnReceiveLineUom({
        uoms: [...list],
        satuan: sat,
        qtyOrdered: qty,
        qtyBase: qty,
        factorToBase: 1,
      });
      expect(r.uom?.satuan).toBe(sat);
      expect(r.qty).toBe(qty);
      expect(r.qtyBase).toBe(qty);
      expect(r.factorToBase).toBe(1);
    }
  });

  it('prefers satuan kirim over mismatched uomId for any product', () => {
    const r = resolveGrnReceiveLineUom({
      uoms: [pcs, box],
      uomId: pcs.id,
      satuan: 'BOX',
      qtyOrdered: 3,
      qtyBase: 36,
    });
    expect(r.uom?.satuan).toBe('BOX');
    expect(r.qty).toBe(3);
  });

  it('converts ONS → KG keeping physical qty', () => {
    const init = resolveGrnReceiveLineUom({
      uoms: [ons, kg],
      satuan: 'KG',
      qtyOrdered: 27,
    });
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
    const broken = patchQtyLineOnUomChange({ qty: 27, factorToBase: undefined }, kg);
    expect(broken.qty).toBe(2.7);

    const fixed = patchQtyLineOnUomChange({ qty: 270, factorToBase: 1 }, kg);
    expect(fixed.qty).toBe(27);
  });
});
