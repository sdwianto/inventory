import { describe, expect, it } from 'vitest';
import { applyLinkedPoTargets, type MaterialRequirementLine } from '@/lib/food-production/material-requirement';

function line(overrides: Partial<MaterialRequirementLine> = {}): MaterialRequirementLine {
  return {
    productId: 'p1',
    productKode: 'SKU1',
    productNama: 'Daun Pandan',
    satuan: 'KG',
    qtyGross: 9,
    qtyOnHand: 0,
    qtyNet: 9,
    shortage: true,
    sources: [],
    ...overrides,
  };
}

describe('applyLinkedPoTargets', () => {
  it('clears shortage when PO qty fully received, even if it differs from recipe qtyGross', () => {
    const poMap = new Map([['p1', { qtyOrdered: 8, qtyReceived: 8 }]]);
    const result = applyLinkedPoTargets([line()], poMap);
    expect(result.lines[0].shortage).toBe(false);
    expect(result.lines[0].qtyNet).toBe(0);
    expect(result.lines[0].sourceOfTruth).toBe('PO');
    expect(result.lines[0].poQtyOrdered).toBe(8);
    expect(result.lines[0].poQtyReceived).toBe(8);
    expect(result.summary.shortageCount).toBe(0);
  });

  it('keeps shortage at the remaining PO shortfall when partially received', () => {
    const poMap = new Map([['p1', { qtyOrdered: 8, qtyReceived: 5 }]]);
    const result = applyLinkedPoTargets([line()], poMap);
    expect(result.lines[0].shortage).toBe(true);
    expect(result.lines[0].qtyNet).toBe(3);
    expect(result.summary.shortageCount).toBe(1);
  });

  it('leaves lines without a matching PO entry untouched (recipe-vs-stock stays authoritative)', () => {
    const poMap = new Map([['other-product', { qtyOrdered: 5, qtyReceived: 5 }]]);
    const result = applyLinkedPoTargets([line()], poMap);
    expect(result.lines[0]).toEqual(line());
    expect(result.lines[0].sourceOfTruth).toBeUndefined();
    expect(result.summary.shortageCount).toBe(1);
  });

  it('recomputes summary across a mix of PO-covered and recipe-only lines', () => {
    const poMap = new Map([['p1', { qtyOrdered: 8, qtyReceived: 8 }]]);
    const result = applyLinkedPoTargets(
      [line(), line({ productId: 'p2', qtyGross: 3, qtyNet: 3 })],
      poMap,
    );
    expect(result.lines[0].shortage).toBe(false);
    expect(result.lines[1].shortage).toBe(true);
    expect(result.summary.shortageCount).toBe(1);
    expect(result.summary.qtyNetTotal).toBe(3);
  });
});
