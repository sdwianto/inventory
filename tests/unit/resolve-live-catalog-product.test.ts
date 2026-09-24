import { describe, expect, it } from 'vitest';
import {
  isCatalogProductActive,
  pickLiveCatalogProduct,
  pickSameSkuInTenant,
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

describe('pickSameSkuInTenant', () => {
  const foreignTempe = {
    id: 'ff8fcd3e-eb6b-4f10-9738-9e38c89e544f',
    kode: 'B711755',
    nama: 'Tempe ',
    vendorStokId: 'bd74b2cc-58ef-4260-94a9-db93bc280f8c',
    aktif: true,
  };

  it('maps another tenant Tempe id to the local row with the same vendor stock id', () => {
    const local = pickSameSkuInTenant(foreignTempe, [
      {
        id: 'a3e46b4e-4f2e-46ee-94a3-e06cfbe0c2d6',
        kode: 'B711755',
        nama: 'Tempe ',
        vendorStokId: 'bd74b2cc-58ef-4260-94a9-db93bc280f8c',
        aktif: true,
      },
      { id: 'other', kode: 'B711755', vendorStokId: 'different', aktif: true },
    ]);
    expect(local?.id).toBe('a3e46b4e-4f2e-46ee-94a3-e06cfbe0c2d6');
  });

  it('maps by masterProductId when stock id differs', () => {
    const local = pickSameSkuInTenant(
      { id: 'foreign', kode: 'B-LAMA', masterProductId: 'mp-tempe', vendorStokId: '' },
      [
        { id: 'local', kode: 'B711755', masterProductId: 'mp-tempe', vendorStokId: 'other', aktif: true },
        { id: 'else', kode: 'B-LAMA', masterProductId: 'mp-lain', aktif: true },
      ],
    );
    expect(local?.id).toBe('local');
  });

  it('maps by vendor and kode when stock id is absent', () => {
    const local = pickSameSkuInTenant(
      { id: 'foreign', kode: 'B511393', vendorTenantId: 'uddawam' },
      [
        { id: 'local', kode: 'B511393', vendorTenantId: 'uddawam', aktif: true },
        { id: 'other-vendor', kode: 'B511393', vendorTenantId: 'zulmy', aktif: true },
      ],
    );
    expect(local?.id).toBe('local');
  });

  it('does not guess when several local rows share only the kode', () => {
    const local = pickSameSkuInTenant(
      { id: 'foreign', kode: 'B402689', vendorStokId: 'missing-here' },
      [
        { id: 'a', kode: 'B402689', vendorStokId: 'v1', aktif: true },
        { id: 'b', kode: 'B402689', vendorStokId: 'v2', aktif: true },
      ],
    );
    expect(local).toBeNull();
  });
});
