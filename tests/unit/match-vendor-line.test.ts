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

  it('falls back to kode+satuan (normalized) when lineId/uomId differ between PO and GRN', () => {
    // PO line dari webhook sales_order dan GRN line dari webhook delivery bisa punya
    // uomId berbeda representasi walau satuannya sama secara teks — kasus nyata yang
    // bikin po.status nyangkut PARTIAL_RECEIVED walau barang sudah diterima lengkap.
    const items = [
      { lineId: 'grn-l1', localStokId: 'other-id', localKode: 'B925034', uomId: 'grn-uom-x', satuan: 'kg', qtyReceived: 4 },
    ];
    const match = findMatchingGrnLine(
      { lineId: 'po-l1', localStokId: 'lp-id', kode: 'B925034', uomId: 'po-uom-y', satuan: 'KG' },
      items,
    );
    expect(match?.qtyReceived).toBe(4);
  });

  it('falls back to kode-only match case-insensitively when unique', () => {
    const items = [
      { lineId: 'grn-l1', vendorKode: 'b426390', qtyReceived: 20 },
    ];
    const match = findMatchingGrnLine(
      { lineId: 'po-l1', kode: 'B426390' },
      items,
    );
    expect(match?.qtyReceived).toBe(20);
  });

  it('returns undefined when no tier matches', () => {
    const match = findMatchingGrnLine(
      { lineId: 'po-l9', localStokId: 'nope', kode: 'ZZZ' },
      grnItems,
    );
    expect(match).toBeUndefined();
  });
});
