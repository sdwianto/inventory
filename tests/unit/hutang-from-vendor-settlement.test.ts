import { describe, expect, it } from 'vitest';
import { resolveHutangSettlement, vendorInvoiceNeedsPendingReview } from '@/lib/api/hutang-from-vendor';

describe('resolveHutangSettlement', () => {
  const txnDate = new Date('2026-08-24T10:00:00Z');

  it('TUNAI → langsung lunas, jatuhTempo = tanggal transaksi', () => {
    const s = resolveHutangSettlement('TUNAI', 10000, null, txnDate);
    expect(s).toEqual({
      terbayar: 10000,
      sisa: 0,
      status: 'LUNAS',
      approvalStatus: 'LUNAS',
      jatuhTempo: txnDate,
    });
  });

  it('TUNAI case-insensitive', () => {
    const s = resolveHutangSettlement('tunai', 5000, null, txnDate);
    expect(s.status).toBe('LUNAS');
    expect(s.sisa).toBe(0);
  });

  it('KREDIT dengan payload.jatuhTempo → dipakai apa adanya', () => {
    const due = '2026-09-23T00:00:00Z';
    const s = resolveHutangSettlement('KREDIT', 10000, due, txnDate);
    expect(s.status).toBe('PENDING_REVIEW');
    expect(s.sisa).toBe(10000);
    expect(s.terbayar).toBe(0);
    expect(s.jatuhTempo).toEqual(new Date(due));
  });

  it('KREDIT tanpa payload.jatuhTempo → fallback darurat +30 hari', () => {
    const s = resolveHutangSettlement('KREDIT', 10000, null, txnDate);
    expect(s.status).toBe('PENDING_REVIEW');
    expect(s.jatuhTempo.getTime()).toBe(txnDate.getTime() + 30 * 86400000);
  });

  it('paymentTerms kosong/undefined → default ke jalur KREDIT', () => {
    const s = resolveHutangSettlement(undefined, 10000, null, txnDate);
    expect(s.status).toBe('PENDING_REVIEW');
  });
});

describe('vendorInvoiceNeedsPendingReview — hutang TUNAI auto-settled', () => {
  it('TUNAI + LUNAS tanpa jejak approval/payment manusia → tidak perlu review (fromPostedGrn=false)', () => {
    const hutang = {
      referenceType: 'VENDOR_INVOICE',
      paymentTerms: 'TUNAI',
      status: 'LUNAS',
      approvalStatus: 'LUNAS',
    };
    expect(vendorInvoiceNeedsPendingReview(hutang as never)).toBe(false);
  });

  it('TUNAI + LUNAS tanpa jejak approval/payment manusia → tidak perlu review (fromPostedGrn=true)', () => {
    const hutang = {
      referenceType: 'VENDOR_INVOICE',
      paymentTerms: 'TUNAI',
      status: 'LUNAS',
      approvalStatus: 'LUNAS',
    };
    expect(vendorInvoiceNeedsPendingReview(hutang as never, { fromPostedGrn: true })).toBe(false);
  });

  it('KREDIT + LUNAS tanpa jejak approval/payment manusia → tetap perlu review (regresi tidak berubah)', () => {
    const hutang = {
      referenceType: 'VENDOR_INVOICE',
      paymentTerms: 'KREDIT',
      status: 'LUNAS',
      approvalStatus: 'LUNAS',
    };
    expect(vendorInvoiceNeedsPendingReview(hutang as never)).toBe(true);
  });
});
