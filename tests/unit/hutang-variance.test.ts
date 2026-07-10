import { describe, expect, it } from 'vitest';
import { poEstimasiForHutang, resolveSoSnapshotForPo } from '@/lib/api/hutang-variance-enrich';
import { buildVendorSoSnapshot, normalizeVendorSoSnapshotLines } from '@/lib/api/vendor-so-snapshot';

describe('poEstimasiForHutang', () => {
  const multiPo = {
    noPO: 'CPO2607000002',
    vendorTenantId: 'multi',
    estimasiTotal: 88426,
    items: [
      { vendorTenantId: 'zulmy', qty: 10, estimasiHarga: 4000, estimasiJumlah: 40000 },
      { vendorTenantId: 'uddawam', qty: 5, estimasiHarga: 6000, estimasiJumlah: 30000 },
      { vendorTenantId: 'puspita', qty: 2, estimasiHarga: 9213, estimasiJumlah: 18426 },
    ],
    vendorSubmissions: [
      { vendorTenantId: 'zulmy', vendorNoSO: 'SO1' },
      { vendorTenantId: 'uddawam', vendorNoSO: 'SO2' },
      { vendorTenantId: 'puspita', vendorNoSO: 'SO3' },
    ],
  };

  it('uses full PO total for single-vendor PO', () => {
    const single = {
      estimasiTotal: 12000,
      items: [{ vendorTenantId: 'zulmy', qty: 3, estimasiHarga: 4000, estimasiJumlah: 12000 }],
      vendorSubmissions: [{ vendorTenantId: 'zulmy', vendorNoSO: 'SO1' }],
    };
    expect(poEstimasiForHutang(single, { vendorTenantId: 'zulmy' })).toBe(12000);
  });

  it('scopes estimasi to matching vendor on multi-vendor PO', () => {
    expect(poEstimasiForHutang(multiPo, { vendorTenantId: 'zulmy' })).toBe(40000);
    expect(poEstimasiForHutang(multiPo, { vendorTenantId: 'uddawam' })).toBe(30000);
    expect(poEstimasiForHutang(multiPo, { vendorTenantId: 'puspita' })).toBe(18426);
  });

  it('resolves vendor via noSO when vendorTenantId missing', () => {
    expect(poEstimasiForHutang(multiPo, { noSO: 'SO2' })).toBe(30000);
  });
});

describe('resolveSoSnapshotForPo', () => {
  it('prefers confirmed vendorSoSnapshot over stale submission without line items', () => {
    const po = {
      vendorSubmissions: [{
        vendorTenantId: 'vendor1',
        vendorSoId: 'so-1',
        vendorNoSO: 'SO001',
        vendorSo: { id: 'so-1', noSO: 'SO001', total: 1000, items: [] },
      }],
      vendorSoSnapshot: {
        salesOrderId: 'so-1',
        noSO: 'SO001',
        total: 1000,
        items: [{ kode: 'B887155', satuan: 'PCS', qty: 1 }],
        confirmedAt: '2026-07-08T00:00:00Z',
      },
    };
    const snap = resolveSoSnapshotForPo(po, { vendorTenantId: 'vendor1', salesOrderId: 'so-1' });
    expect(snap?.items).toHaveLength(1);
    expect(snap?.items?.[0].qty).toBe(1);
  });

  it('normalizes legacy snapshot lines that only have qtyOrdered', () => {
    const snap = buildVendorSoSnapshot({
      noSO: 'SO001',
      total: 184348,
      items: [{ kode: 'B618394', qtyOrdered: 2, harga: 1000, jumlah: 2000 }],
    });
    expect(snap?.items?.[0].qty).toBe(2);

    const legacy = normalizeVendorSoSnapshotLines({
      noSO: 'SO001',
      total: 184348,
      items: [{ kode: 'B618394', qtyOrdered: 2, harga: 1000, jumlah: 2000 }],
    });
    expect(legacy?.items?.[0].qty).toBe(2);
  });
});
