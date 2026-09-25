import { describe, expect, it } from 'vitest';
import {
  hasActivity,
  parseMergeDecisions,
  pickDefaultCanonical,
} from '@/lib/migrations/0003-merge-duplicate-products';
import { buildUomIdMap, canonicalIdsForRows, isDuplicateKodeError, PRODUCT_KODE_UNIQUE_INDEX } from '@/lib/api/product-merge';
import { pickLiveCatalogProduct, pickSameSkuInTenant } from '@/lib/api/resolve-live-catalog-product';

describe('migrasi 0003 — helper', () => {
  it('parseMergeDecisions menerima objek, array, dan pembungkus { decisions }', () => {
    expect([...parseMergeDecisions({ BR01: 'a', ' GL01 ': ' b ', KOSONG: '' })]).toEqual([['BR01', 'a'], ['GL01', 'b']]);
    expect([...parseMergeDecisions([{ kode: 'BR01', canonicalId: 'a' }, { kode: '', canonicalId: 'x' }])]).toEqual([['BR01', 'a']]);
    expect([...parseMergeDecisions({ decisions: [{ kode: 'TL01', canonicalId: 't' }] })]).toEqual([['TL01', 't']]);
    expect(parseMergeDecisions(undefined).size).toBe(0);
  });

  it('pickDefaultCanonical: aktif → master lokal → paling awal → id', () => {
    const d = (id: string, extra: Record<string, unknown> = {}) => ({ id, aktif: true, syncSource: 'sales.app', createdAt: new Date('2026-01-01'), ...extra });
    expect(pickDefaultCanonical([d('a', { aktif: false, createdAt: new Date('2020-01-01') }), d('b')]).id).toBe('b');
    expect(pickDefaultCanonical([d('a'), d('b', { syncSource: 'local' })]).id).toBe('b');
    expect(pickDefaultCanonical([d('a'), d('b', { createdAt: new Date('2025-01-01') })]).id).toBe('b');
    expect(pickDefaultCanonical([d('b'), d('a')]).id).toBe('a');
  });

  it('hasActivity true bila ada salah satu jejak', () => {
    const zero = { kartu: 0, stokQty: 0, lots: 0, recipes: 0, releases: 0, issues: 0, mrps: 0, cpos: 0, grns: 0 };
    expect(hasActivity(zero)).toBe(false);
    expect(hasActivity({ ...zero, cpos: 1 })).toBe(true);
    expect(hasActivity({ ...zero, stokQty: 0.5 })).toBe(true);
  });

  it('buildUomIdMap hanya memetakan satuan + faktor yang sama', () => {
    const map = buildUomIdMap(
      [{ id: 's-kg', satuan: 'kg', factorToBase: 1 }, { id: 's-sak', satuan: 'SAK', factorToBase: 25 }, { id: 's-dus', satuan: 'DUS', factorToBase: 12 }],
      [{ id: 'c-kg', satuan: 'KG', factorToBase: 1 }, { id: 'c-sak', satuan: 'SAK', factorToBase: 50 }, { id: 'c-dus', satuan: 'DUS', factorToBase: 12 }],
    );
    expect([...map]).toEqual([['s-kg', 'c-kg'], ['s-dus', 'c-dus']]);
  });
});

describe('product-merge — helper', () => {
  it('canonicalIdsForRows memetakan salinan ke kanonik', () => {
    expect(canonicalIdsForRows([{ id: 'a' }, { id: 'b', mergedInto: 'a' }, { id: 'c', mergedInto: 'x' }]).sort()).toEqual(['a', 'x']);
  });

  it('isDuplicateKodeError hanya untuk index kode aktif', () => {
    expect(isDuplicateKodeError({ code: 11000, message: `E11000 duplicate key error index: ${PRODUCT_KODE_UNIQUE_INDEX}` })).toBe(true);
    expect(isDuplicateKodeError({ code: 11000, message: 'E11000 index: uniq_products_tenant_vendor_kode' })).toBe(false);
    expect(isDuplicateKodeError(new Error('lain'))).toBe(false);
  });
});

describe('resolve katalog — salinan vendor tergabung', () => {
  const canon = { id: 'c', kode: 'BR01', aktif: true, vendorTenantId: 'v1', vendorStokId: 's1' };
  const merged = { id: 'm', kode: 'BR01', aktif: true, vendorTenantId: 'v2', vendorStokId: 's2', mergedInto: 'c' };

  it('pickLiveCatalogProduct tidak memilih salinan tergabung kecuali diminta', () => {
    const current = { id: 'old', kode: 'BR01', vendorTenantId: 'v2', aktif: false };
    expect(pickLiveCatalogProduct(current, [merged, canon])?.id).toBe('c');
    expect(pickLiveCatalogProduct(current, [merged, canon], { includeMerged: true })?.id).toBe('m');
    expect(pickLiveCatalogProduct(current, [merged])).toBeNull();
  });

  it('pickSameSkuInTenant: salinan tergabung hanya cocok lewat vendorStokId', () => {
    expect(pickSameSkuInTenant({ vendorStokId: 's2', kode: 'BR01' }, [canon, merged])?.id).toBe('m');
    expect(pickSameSkuInTenant({ kode: 'BR01', vendorTenantId: 'v2' }, [canon, merged])?.id).toBe('c');
  });
});
