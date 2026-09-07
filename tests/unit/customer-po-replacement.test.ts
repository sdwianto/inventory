import { describe, expect, it } from 'vitest';
import { assertVendorReturnReplacementEligible } from '@/lib/api/handlers/customer-po';
import type { VendorReturnDoc, VendorReturnLine } from '@/types/vendor-return';

function line(vendorDecision?: VendorReturnLine['vendorDecision']): VendorReturnLine {
  return {
    lineId: 'inv:l1',
    localStokId: 'p1',
    localKode: 'B998100',
    localNama: 'Apel Fuji',
    satuan: 'PCS',
    qty: 1,
    qtyBase: 1,
    harga: 1000,
    jumlah: 1000,
    gudangKode: 'GBASAH',
    vendorDecision,
  };
}

function vr(overrides: Partial<VendorReturnDoc>): VendorReturnDoc {
  return {
    id: 'vr1',
    tenantId: 'sppg',
    noReturn: 'RTV001',
    status: 'POSTED',
    vendorTenantId: 'puspita',
    reason: 'test',
    items: [line('ACCEPTED')],
    subTotal: 1000,
    total: 1000,
    cnSyncStatus: 'DONE',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('assertVendorReturnReplacementEligible', () => {
  it('rejects when vendor-return is not found', () => {
    expect(assertVendorReturnReplacementEligible(null)).toMatch(/tidak ditemukan/i);
  });

  it('rejects when vendor-return is not yet POSTED', () => {
    expect(assertVendorReturnReplacementEligible(vr({ status: 'DRAFT' }))).toMatch(/belum posting/i);
  });

  it('rejects when no line was accepted by vendor (all PENDING)', () => {
    const doc = vr({ items: [line('PENDING'), line('PENDING')] });
    expect(assertVendorReturnReplacementEligible(doc)).toMatch(/tidak punya baris yang diterima/i);
  });

  it('rejects when every line was rejected by vendor', () => {
    const doc = vr({ items: [line('REJECTED'), line('REJECTED')] });
    expect(assertVendorReturnReplacementEligible(doc)).toMatch(/tidak punya baris yang diterima/i);
  });

  it('allows when at least one line is ACCEPTED, even mixed with REJECTED', () => {
    const doc = vr({ items: [line('ACCEPTED'), line('REJECTED')] });
    expect(assertVendorReturnReplacementEligible(doc)).toBeNull();
  });

  it('allows when all lines are ACCEPTED', () => {
    expect(assertVendorReturnReplacementEligible(vr({}))).toBeNull();
  });
});
