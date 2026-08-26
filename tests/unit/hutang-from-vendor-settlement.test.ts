import { describe, expect, it } from 'vitest';
import { resolveHutangSettlement, vendorInvoiceNeedsPendingReview } from '@/lib/api/hutang-from-vendor';

describe('resolveHutangSettlement', () => {
  const txnDate = new Date('2026-08-24T10:00:00Z');

  it('selalu PENDING_REVIEW, terlepas dari payment terms (TUNAI tidak lagi auto-lunas)', () => {
    const due = '2026-09-23T00:00:00Z';
    const s = resolveHutangSettlement(10000, due, txnDate);
    expect(s).toEqual({
      terbayar: 0,
      sisa: 10000,
      status: 'PENDING_REVIEW',
      approvalStatus: 'PENDING_REVIEW',
      jatuhTempo: new Date(due),
    });
  });

  it('dengan payload.jatuhTempo → dipakai apa adanya', () => {
    const due = '2026-09-23T00:00:00Z';
    const s = resolveHutangSettlement(10000, due, txnDate);
    expect(s.status).toBe('PENDING_REVIEW');
    expect(s.sisa).toBe(10000);
    expect(s.terbayar).toBe(0);
    expect(s.jatuhTempo).toEqual(new Date(due));
  });

  it('tanpa payload.jatuhTempo → fallback darurat +30 hari', () => {
    const s = resolveHutangSettlement(10000, null, txnDate);
    expect(s.status).toBe('PENDING_REVIEW');
    expect(s.jatuhTempo.getTime()).toBe(txnDate.getTime() + 30 * 86400000);
  });
});

describe('vendorInvoiceNeedsPendingReview', () => {
  it('TUNAI + LUNAS tanpa jejak approval/payment manusia → tetap perlu review (auto-settle TUNAI sudah dihapus)', () => {
    const hutang = {
      referenceType: 'VENDOR_INVOICE',
      paymentTerms: 'TUNAI',
      status: 'LUNAS',
      approvalStatus: 'LUNAS',
    };
    expect(vendorInvoiceNeedsPendingReview(hutang as never)).toBe(true);
    expect(vendorInvoiceNeedsPendingReview(hutang as never, { fromPostedGrn: true })).toBe(true);
  });

  it('KREDIT + LUNAS tanpa jejak approval/payment manusia → tetap perlu review', () => {
    const hutang = {
      referenceType: 'VENDOR_INVOICE',
      paymentTerms: 'KREDIT',
      status: 'LUNAS',
      approvalStatus: 'LUNAS',
    };
    expect(vendorInvoiceNeedsPendingReview(hutang as never)).toBe(true);
  });

  it('LUNAS dengan jejak pembayaran eksternal manusia yang sah → tidak perlu review', () => {
    const hutang = {
      referenceType: 'VENDOR_INVOICE',
      paymentTerms: 'TUNAI',
      status: 'LUNAS',
      approvalStatus: 'LUNAS',
      paidExternalAt: new Date(),
      paidExternalBy: { userId: 'u1' },
    };
    expect(vendorInvoiceNeedsPendingReview(hutang as never)).toBe(false);
  });

  it('PENDING_REVIEW selalu dianggap sudah pada tempatnya', () => {
    const hutang = {
      referenceType: 'VENDOR_INVOICE',
      paymentTerms: 'TUNAI',
      status: 'PENDING_REVIEW',
      approvalStatus: 'PENDING_REVIEW',
    };
    expect(vendorInvoiceNeedsPendingReview(hutang as never)).toBe(false);
  });
});
