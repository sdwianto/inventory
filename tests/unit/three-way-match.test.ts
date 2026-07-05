import { describe, expect, it } from 'vitest';
import { lineMatchKey, matchInvoiceLinesAgainstGrn } from '@/lib/api/three-way-match';
import type { VendorInvoicePayload } from '@/types/integration';

describe('lineMatchKey', () => {
  it('includes stokId in bucket key when provided', () => {
    expect(lineMatchKey('SKU-OLD', 'uom-box', 'BOX', 'stok-abc')).toBe('stok-abc::uom-box');
    expect(lineMatchKey('SKU-OLD', 'uom-box', 'BOX')).toBe('SKU-OLD::uom-box');
  });
});

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

  it('matches per UOM when same SKU has two units', () => {
    const multiGrn = [{
      items: [
        { vendorKode: 'SKU1', uomId: 'uom-box', satuan: 'BOX', qtyReceived: 2, harga: 50000 },
        { vendorKode: 'SKU1', uomId: 'uom-pcs', satuan: 'PCS', qtyReceived: 24, harga: 5000 },
      ],
    }];
    const okPayload: VendorInvoicePayload = {
      noDO: 'DO-002',
      total: 220000,
      items: [
        { kode: 'SKU1', uomId: 'uom-box', satuan: 'BOX', qty: 2 },
        { kode: 'SKU1', uomId: 'uom-pcs', satuan: 'PCS', qty: 20 },
      ],
    };
    expect(matchInvoiceLinesAgainstGrn(multiGrn, okPayload).ok).toBe(true);

    const badBox: VendorInvoicePayload = {
      noDO: 'DO-002',
      total: 100000,
      items: [{ kode: 'SKU1', uomId: 'uom-box', satuan: 'BOX', qty: 5 }],
    };
    const fail = matchInvoiceLinesAgainstGrn(multiGrn, badBox);
    expect(fail.ok).toBe(false);
    expect(fail.code).toBe('QTY_MISMATCH');
    expect(fail.error).toMatch(/BOX/i);
  });

  it('matches by stokId+uomId when kode berbeda', () => {
    const grns = [{
      items: [
        { localStokId: 'stok-abc', vendorKode: 'V-OLD', uomId: 'uom-box', satuan: 'BOX', qtyReceived: 3, harga: 10000 },
      ],
    }];
    const payload: VendorInvoicePayload = {
      noDO: 'DO-003',
      total: 30000,
      items: [{ stokId: 'stok-abc', kode: 'SKU-NEW', uomId: 'uom-box', satuan: 'BOX', qty: 3 }],
    };
    expect(matchInvoiceLinesAgainstGrn(grns, payload).ok).toBe(true);
  });
});
