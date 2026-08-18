import { describe, expect, it } from 'vitest';
import { vendorBillingFromPayload } from '@/lib/api/hutang-detail-enrich';

// Regresi: warnaBrand vendor sebelumnya hilang di sepanjang jalur payload webhook ->
// snapshot tersimpan di hutang -> render VendorInvoiceDocument.tsx, karena beberapa titik
// (pickStoreFields, vendorBillingFromPayload, sanitizeStoreSettings lokal) tidak pernah
// membawa field ini. Test ini mengunci bahwa vendorBillingFromPayload() — titik masuk dari
// webhook invoice.posted — sudah membawa warnaBrand dengan benar.

describe('vendorBillingFromPayload — warnaBrand', () => {
  it('mengambil warnaBrand dari field nested vendor.warnaBrand', () => {
    const billing = vendorBillingFromPayload({
      vendorTenantId: 'zulmy',
      vendor: { companyName: 'UD Dawam', warnaBrand: '#ea580c' },
    }, 'zulmy');
    expect(billing.warnaBrand).toBe('#ea580c');
  });

  it('fallback ke field top-level vendorWarnaBrand kalau nested tidak ada', () => {
    const billing = vendorBillingFromPayload({
      vendorTenantId: 'zulmy',
      vendorCompanyName: 'UD Dawam',
      vendorWarnaBrand: '#123456',
    }, 'zulmy');
    expect(billing.warnaBrand).toBe('#123456');
  });

  it('kosong (bukan undefined) kalau vendor belum pernah set warna', () => {
    const billing = vendorBillingFromPayload({
      vendorTenantId: 'zulmy',
      vendorCompanyName: 'UD Dawam',
    }, 'zulmy');
    expect(billing.warnaBrand).toBe('');
  });
});
