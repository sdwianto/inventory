import { describe, expect, it } from 'vitest';
import {
  isCatalogProductActive,
  pickLiveCatalogProduct,
  attachLiveCatalogProducts,
} from '@/lib/api/resolve-live-catalog-product';

describe('pickLiveCatalogProduct', () => {
  const inactive = {
    id: 'old',
    kode: 'B667077',
    nama: 'Daging Ayam Potongan 10',
    aktif: false,
    vendorTenantId: 'uddawam',
    masterProductId: 'mp-ayam',
  };

  it('picks same-vendor active copy of the same kode', () => {
    const live = pickLiveCatalogProduct(inactive, [
      inactive,
      { id: 'new', kode: 'B667077', aktif: true, vendorTenantId: 'uddawam' },
      { id: 'other', kode: 'B667077', aktif: true, vendorTenantId: 'zulmy' },
    ]);
    expect(live?.id).toBe('new');
  });

  it('falls back to same masterProductId from another vendor', () => {
    const live = pickLiveCatalogProduct(inactive, [
      { id: 'zulmy-copy', kode: 'B667077', aktif: true, vendorTenantId: 'zulmy', masterProductId: 'mp-ayam' },
    ]);
    expect(live?.id).toBe('zulmy-copy');
  });

  it('falls back to any active kode when vendor/master do not match', () => {
    const live = pickLiveCatalogProduct(
      { ...inactive, masterProductId: null },
      [{ id: 'zulmy-copy', kode: 'B667077', aktif: true, vendorTenantId: 'zulmy' }],
    );
    expect(live?.id).toBe('zulmy-copy');
  });

  it('follows cutoverToKode', () => {
    const live = pickLiveCatalogProduct(
      { ...inactive, cutoverToKode: 'B667077-KG' },
      [{ id: 'kg', kode: 'B667077-KG', aktif: true, vendorTenantId: 'uddawam' }],
    );
    expect(live?.id).toBe('kg');
  });

  it('returns null when no active sibling exists', () => {
    expect(pickLiveCatalogProduct(inactive, [inactive])).toBeNull();
  });
});

describe('isCatalogProductActive', () => {
  it('treats missing aktif as active', () => {
    expect(isCatalogProductActive({ id: '1' })).toBe(true);
  });
  it('rejects explicit inactive', () => {
    expect(isCatalogProductActive({ id: '1', aktif: false })).toBe(false);
  });
});

describe('attachLiveCatalogProducts', () => {
  it('remaps inactive recipe id to the live sibling', async () => {
    const rows = [
      { id: 'old', kode: 'B667077', aktif: false, vendorTenantId: 'uddawam', tenantId: 'sppg' },
      { id: 'live', kode: 'B667077', aktif: true, vendorTenantId: 'zulmy', tenantId: 'sppg' },
    ];
    const db = {
      collection: () => ({
        find: () => ({
          toArray: async () => rows.filter((r) => r.aktif !== false),
        }),
      }),
    };
    const map = await attachLiveCatalogProducts(db as never, 'sppg', rows);
    expect(map.get('old')?.id).toBe('live');
    expect(map.get('live')?.id).toBe('live');
  });
});
