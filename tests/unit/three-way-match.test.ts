import { describe, expect, it } from 'vitest';
import { matchInvoiceLinesAgainstGrn } from '@/lib/api/three-way-match';
import type { VendorInvoicePayload } from '@/types/integration';

describe('three-way-match', () => {
  const grns = [{
    items: [
      { vendorKode: 'SKU1', qtyReceived: 10, harga: 1000 },
      { vendorKode: 'SKU2', qtyReceived: 5, harga: 2000 },
    ],
  }];

  it('passes when invoice qty and total within tolerance', () => {
    const payload: VendorInvoicePayload = {
      noDO: 'DO-001',
      total: 20000,
      items: [{ kode: 'SKU1', qty: 10 }, { kode: 'SKU2', qty: 5 }],
    };
    const result = matchInvoiceLinesAgainstGrn(grns, payload);
    expect(result.ok).toBe(true);
    expect(result.grnValue).toBe(20000);
  });

  it('fails on qty mismatch', () => {
    const payload: VendorInvoicePayload = {
      noDO: 'DO-001',
      total: 20000,
      items: [{ kode: 'SKU1', qty: 15 }],
    };
    const result = matchInvoiceLinesAgainstGrn(grns, payload);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('QTY_MISMATCH');
  });

  it('fails on price mismatch beyond tolerance', () => {
    const payload: VendorInvoicePayload = {
      noDO: 'DO-001',
      total: 25000,
      items: [{ kode: 'SKU1', qty: 10 }, { kode: 'SKU2', qty: 5 }],
    };
    const result = matchInvoiceLinesAgainstGrn(grns, payload, { priceTolerancePct: 2 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PRICE_MISMATCH');
  });
});
