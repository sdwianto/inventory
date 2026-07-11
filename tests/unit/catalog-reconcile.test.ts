import { describe, expect, it } from 'vitest';
import {
  vendorCatalogKey,
  vendorCatalogKeyFromProduct,
  isVendorProductActive,
} from '@/lib/api/product-sync';

describe('vendorCatalogKeyFromProduct', () => {
  it('builds key from catalog row', () => {
    expect(vendorCatalogKeyFromProduct({
      id: 'stok-1',
      vendorTenantId: 'uddawam',
    })).toBe('uddawam:stok-1');
  });

  it('falls back to tenantId for sales-native rows', () => {
    expect(vendorCatalogKeyFromProduct({
      id: 'stok-2',
      tenantId: 'abiliyan',
    })).toBe('abiliyan:stok-2');
  });

  it('returns null when ids missing', () => {
    expect(vendorCatalogKeyFromProduct({ kode: 'B1' })).toBeNull();
  });
});

describe('vendorCatalogKey', () => {
  it('joins tenant and stok id', () => {
    expect(vendorCatalogKey('v1', 's1')).toBe('v1:s1');
  });
});

describe('isVendorProductActive', () => {
  it('treats missing aktif as active', () => {
    expect(isVendorProductActive({ kode: 'A' })).toBe(true);
  });

  it('rejects explicit inactive', () => {
    expect(isVendorProductActive({ aktif: false })).toBe(false);
  });
});
