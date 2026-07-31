import { describe, expect, it } from 'vitest';
import {
  buildRevisedPoItemPayloads,
  buildReviseCatatan,
  canReviseCancelledPoStatus,
} from '@/lib/pembelian-po/revise-from-cancelled';

describe('revise-from-cancelled', () => {
  it('allows CANCELLED and PARTIAL_CANCELLED only', () => {
    expect(canReviseCancelledPoStatus('CANCELLED')).toBe(true);
    expect(canReviseCancelledPoStatus('PARTIAL_CANCELLED')).toBe(true);
    expect(canReviseCancelledPoStatus('SUBMITTED')).toBe(false);
    expect(canReviseCancelledPoStatus('DRAFT')).toBe(false);
  });

  it('restores qtyOriginal for cancelled lines', () => {
    const items = buildRevisedPoItemPayloads([
      {
        kode: 'B103629',
        nama: 'Makaroni',
        qty: 0,
        qtyOriginal: 153,
        cancelled: true,
        satuan: 'KG',
        localStokId: 'p1',
        vendorTenantId: 'uddawam',
      },
      {
        kode: 'B456763',
        nama: 'Ayam',
        qty: 135,
        satuan: 'KG',
        localStokId: 'p2',
        vendorTenantId: 'uddawam',
      },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].qty).toBe(153);
    expect(items[0].cancelled).toBeUndefined();
    expect(items[1].qty).toBe(135);
  });

  it('skips zero-qty lines', () => {
    const items = buildRevisedPoItemPayloads([
      { kode: 'X', qty: 0, cancelled: true },
      { kode: 'Y', qty: 2, satuan: 'PCS' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kode).toBe('Y');
  });

  it('prefixes catatan with revisi note', () => {
    expect(buildReviseCatatan('CPO2607000003')).toBe('Revisi dari CPO2607000003');
    expect(buildReviseCatatan('CPO2607000003', 'Urgent')).toBe(
      'Revisi dari CPO2607000003\nUrgent',
    );
  });
});
