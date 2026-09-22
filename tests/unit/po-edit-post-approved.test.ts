import { describe, expect, it } from 'vitest';
import {
  canEditCustomerPo,
  isPostApprovedPoEditStatus,
  poHasReceivedQty,
} from '@/lib/pembelian-po/permissions';

describe('canEditCustomerPo — post-approve in-place', () => {
  const approved = {
    id: 'po1',
    status: 'APPROVED',
    items: [{ qty: 2, qtyReceived: 0 }],
    createdBy: { userId: 'u1' },
  };

  it('allows ADMIN/SUPERVISOR on APPROVED without receive', () => {
    expect(canEditCustomerPo('ADMIN', approved)).toBe(true);
    expect(canEditCustomerPo('SUPERVISOR', approved)).toBe(true);
    expect(canEditCustomerPo('MASTER', approved, { isMaster: true })).toBe(true);
  });

  it('blocks GUDANG on APPROVED', () => {
    expect(canEditCustomerPo('GUDANG', approved, { userId: 'u1' })).toBe(false);
  });

  it('blocks when any qtyReceived > 0', () => {
    const received = {
      ...approved,
      items: [{ qty: 2, qtyReceived: 1 }],
    };
    expect(canEditCustomerPo('ADMIN', received)).toBe(false);
    expect(poHasReceivedQty(received)).toBe(true);
  });

  it('allows SUBMITTED/CONFIRMED without receive', () => {
    expect(canEditCustomerPo('ADMIN', { ...approved, status: 'SUBMITTED' })).toBe(true);
    expect(canEditCustomerPo('SUPERVISOR', { ...approved, status: 'CONFIRMED' })).toBe(true);
    expect(isPostApprovedPoEditStatus('SUBMITTED')).toBe(true);
  });

  it('still blocks RECEIVED/INVOICED', () => {
    expect(canEditCustomerPo('ADMIN', { ...approved, status: 'RECEIVED' })).toBe(false);
    expect(canEditCustomerPo('ADMIN', { ...approved, status: 'INVOICED' })).toBe(false);
  });

  it('keeps DRAFT rules for GUDANG creator', () => {
    const draft = { ...approved, status: 'DRAFT' };
    expect(canEditCustomerPo('GUDANG', draft, { userId: 'u1' })).toBe(true);
    expect(canEditCustomerPo('GUDANG', draft, { userId: 'other' })).toBe(false);
  });
});
