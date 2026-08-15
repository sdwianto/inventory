import { describe, expect, it } from 'vitest';
import {
  buildProductSearchFilter,
  mergeFilterWithVendorTenantIds,
  applyProductCatalogFilters,
} from '@/lib/api/product-query';

describe('buildProductSearchFilter vendor', () => {
  it('includes vendorTenantName for short code-like vendor fragment', () => {
    const f = buildProductSearchFilter('dawam');
    const json = JSON.stringify(f);
    expect(json).toContain('vendorTenantName');
    expect(json).toContain('vendorTenantId');
  });

  it('includes vendor fields for longer non-code term', () => {
    const f = buildProductSearchFilter('sayur');
    const json = JSON.stringify(f);
    expect(json).toContain('vendorTenantName');
  });
});

describe('mergeFilterWithVendorTenantIds', () => {
  it('wraps $text filter with vendor tenant ids', () => {
    const merged = mergeFilterWithVendorTenantIds(
      { $text: { $search: 'UD Dawam' } },
      ['vendor-1'],
    );
    expect(merged).toEqual({
      $or: [
        { $text: { $search: 'UD Dawam' } },
        { vendorTenantId: { $in: ['vendor-1'] } },
      ],
    });
  });

  it('appends vendor clause to existing $or', () => {
    const merged = mergeFilterWithVendorTenantIds(
      { $or: [{ nama: { $regex: 'cabai', $options: 'i' } }] },
      ['v2'],
    );
    expect(merged.$or).toHaveLength(2);
    expect(merged.$or?.[1]).toEqual({ vendorTenantId: { $in: ['v2'] } });
  });
});

describe('applyProductCatalogFilters', () => {
  it('filters a single warehouse', () => {
    const { filter, error } = applyProductCatalogFilters({}, { gudangKode: 'GJANITOR' });
    expect(error).toBeUndefined();
    expect(filter.gudangKode).toBe('GJANITOR');
  });

  it('filters multiple warehouses', () => {
    const { filter, error } = applyProductCatalogFilters({}, { gudangKode: 'GKERING,GBASAH' });
    expect(error).toBeUndefined();
    expect(filter.gudangKode).toEqual({ $in: ['GKERING', 'GBASAH'] });
  });

  it('rejects invalid warehouse', () => {
    const { error } = applyProductCatalogFilters({}, { gudangKode: 'GFOO' });
    expect(error).toBe('gudangKode filter tidak valid');
  });
});
