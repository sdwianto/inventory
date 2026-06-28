import { describe, expect, it } from 'vitest';
import {
  isLocalPo,
  isVendorPo,
  normalizePoChannel,
  vendorPoWriteFields,
} from '@/lib/api/po-channel';
import { PO_CHANNEL_LOCAL, PO_CHANNEL_VENDOR } from '@/types/purchase-order';

describe('po-channel', () => {
  it('defaults unknown/missing channel to VENDOR', () => {
    expect(normalizePoChannel(undefined)).toBe(PO_CHANNEL_VENDOR);
    expect(normalizePoChannel(null)).toBe(PO_CHANNEL_VENDOR);
    expect(normalizePoChannel('OTHER')).toBe(PO_CHANNEL_VENDOR);
  });

  it('recognizes LOCAL channel', () => {
    expect(normalizePoChannel(PO_CHANNEL_LOCAL)).toBe(PO_CHANNEL_LOCAL);
    expect(isLocalPo({ poChannel: PO_CHANNEL_LOCAL })).toBe(true);
    expect(isVendorPo({ poChannel: PO_CHANNEL_LOCAL })).toBe(false);
  });

  it('stamps vendor PO writes', () => {
    expect(vendorPoWriteFields()).toEqual({ poChannel: PO_CHANNEL_VENDOR });
    expect(vendorPoWriteFields({ catatan: 'test' })).toEqual({
      poChannel: PO_CHANNEL_VENDOR,
      catatan: 'test',
    });
  });
});
