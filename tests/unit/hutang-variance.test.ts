import { describe, expect, it } from 'vitest';
import { poEstimasiForHutang } from '@/lib/api/hutang-variance-enrich';

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
