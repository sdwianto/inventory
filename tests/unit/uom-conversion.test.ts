import { describe, it, expect } from 'vitest';
import {
  toBaseQty,
  fromBaseQty,
  validateAndNormalizeUomInputs,
  resolveUomInputsFromProductBody,
  pickBaseUom,
  formatDualQtyDisplay,
  uomInputsFromLegacyProductBody,
} from '@/lib/uom/conversion';
import type { ProductUom } from '@/lib/uom/types';

describe('inventory uom conversion', () => {
  it('converts box to base sachet', () => {
    expect(toBaseQty(2, 10)).toBe(20);
    expect(fromBaseQty(20, 10)).toBe(2);
  });

  it('normalizes legacy product body', () => {
    const inputs = resolveUomInputsFromProductBody({ satuan: 'pcs', hargaEcer: 500 });
    const r = validateAndNormalizeUomInputs(inputs);
    expect('ok' in r && r.ok).toBe(true);
  });

  it('normalizes multi-UOM input', () => {
    const r = validateAndNormalizeUomInputs([
      { satuan: 'SACHET', isBase: true, factorToBase: 1, hargaEcer: 2000 },
      { satuan: 'BOX', isBase: false, factorToBase: 10, hargaEcer: 18000 },
    ]);
    expect('ok' in r && r.ok).toBe(true);
  });

  it('rejects duplicate satuan', () => {
    const r = validateAndNormalizeUomInputs([
      { satuan: 'PCS', isBase: true, factorToBase: 1 },
      { satuan: 'pcs', isBase: false, factorToBase: 2 },
    ]);
    expect('error' in r).toBe(true);
  });

  it('pickBaseUom prefers isBase row', () => {
    const uoms = [
      { id: '1', satuan: 'BOX', isBase: false, factorToBase: 10 },
      { id: '2', satuan: 'PCS', isBase: true, factorToBase: 1 },
    ] as ProductUom[];
    expect(pickBaseUom(uoms)?.id).toBe('2');
  });

  it('formatDualQtyDisplay shows alternate packaging', () => {
    const text = formatDualQtyDisplay(20, 'SACHET', { satuan: 'BOX', factorToBase: 10, isBase: false });
    expect(text).toContain('20 SACHET');
    expect(text).toContain('BOX');
  });

  it('legacy uom input maps vendor price fallbacks', () => {
    const inputs = uomInputsFromLegacyProductBody({
      satuan: 'KG',
      hargaEcer: '1000',
    });
    expect(inputs[0].satuan).toBe('KG');
    expect(inputs[0].hargaEcer).toBe(1000);
  });
});
