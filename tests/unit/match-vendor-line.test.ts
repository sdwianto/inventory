import { describe, expect, it } from 'vitest';
import { findMatchingGrnLine, findMatchingVendorWebhookLine } from '@/lib/uom/match-vendor-line';

describe('findMatchingVendorWebhookLine', () => {
  const webhookItems = [
    { lineId: 'l-box', stokId: 'vp1', kode: 'A', uomId: 'vendor-box', qty: 2 },
    { lineId: 'l-pcs', stokId: 'vp1', kode: 'A', uomId: 'vendor-pcs', qty: 10 },
  ];

  it('matches by vendorStokId + vendorUomId', () => {
    const used = new Set<number>();
    const match = findMatchingVendorWebhookLine(
      { vendorStokId: 'vp1', vendorUomId: 'vendor-box' },
      webhookItems,
      used,
    );
    expect(match?.uomId).toBe('vendor-box');
    expect(match?.qty).toBe(2);
  });

  it('does not conflate same SKU different UOM', () => {
    const used = new Set<number>();
    findMatchingVendorWebhookLine(
      { vendorStokId: 'vp1', vendorUomId: 'vendor-box' },
      webhookItems,
      used,
    );
    const second = findMatchingVendorWebhookLine(
      { vendorStokId: 'vp1', vendorUomId: 'vendor-pcs' },
      webhookItems,
      used,
    );
    expect(second?.qty).toBe(10);
  });
});

describe('findMatchingGrnLine', () => {
  const grnItems = [
    { lineId: 'l1', localStokId: 'lp1', localKode: 'A', uomId: 'local-box', qtyReceived: 2 },
    { lineId: 'l2', localStokId: 'lp1', localKode: 'A', uomId: 'local-pcs', qtyReceived: 5 },
  ];

  it('matches GRN line by localStokId + uomId', () => {
    const match = findMatchingGrnLine(
      { localStokId: 'lp1', uomId: 'local-pcs' },
      grnItems,
    );
    expect(match?.qtyReceived).toBe(5);
  });
});
