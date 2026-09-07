import { describe, expect, it } from 'vitest';
import { findInflightVendorReturnSibling, isVendorReturnInflightSibling } from '@/lib/api/vendor-return-inflight';

describe('vendor-return-inflight', () => {
  it('mengabaikan self dan grn-reject', () => {
    expect(isVendorReturnInflightSibling(
      { id: 'a', status: 'PENDING_APPROVAL' },
      'a',
    )).toBe(false);
    expect(isVendorReturnInflightSibling(
      { id: 'b', source: 'grn-reject', status: 'POSTED', vendorDecision: 'PENDING', creditNoteId: 'cn' },
      'a',
    )).toBe(false);
  });

  it('blokir PENDING_APPROVAL / POSTING', () => {
    expect(isVendorReturnInflightSibling({ id: 'b', status: 'PENDING_APPROVAL' }, 'a')).toBe(true);
    expect(isVendorReturnInflightSibling({ id: 'b', status: 'POSTING' }, 'a')).toBe(true);
  });

  it('blokir POSTED dengan CN SYNCING atau FAILED tanpa creditNoteId', () => {
    expect(isVendorReturnInflightSibling(
      { id: 'b', status: 'POSTED', cnSyncStatus: 'SYNCING', vendorDecision: 'PENDING' },
      'a',
    )).toBe(true);
    expect(isVendorReturnInflightSibling(
      { id: 'b', status: 'POSTED', cnSyncStatus: 'FAILED', vendorDecision: 'PENDING' },
      'a',
    )).toBe(true);
  });

  it('blokir POSTED menunggu vendor (PENDING) meski CN DONE', () => {
    expect(isVendorReturnInflightSibling(
      {
        id: 'b',
        status: 'POSTED',
        cnSyncStatus: 'DONE',
        vendorDecision: 'PENDING',
        creditNoteId: 'cn-1',
      },
      'a',
    )).toBe(true);
  });

  it('tidak blokir setelah ACCEPTED/REJECTED', () => {
    expect(isVendorReturnInflightSibling(
      { id: 'b', status: 'POSTED', cnSyncStatus: 'DONE', vendorDecision: 'ACCEPTED', creditNoteId: 'cn' },
      'a',
    )).toBe(false);
    expect(isVendorReturnInflightSibling(
      { id: 'b', status: 'POSTED', cnSyncStatus: 'DONE', vendorDecision: 'REJECTED', creditNoteId: 'cn' },
      'a',
    )).toBe(false);
  });

  it('findInflightVendorReturnSibling mengembalikan sibling pertama', () => {
    const hit = findInflightVendorReturnSibling(
      [
        { id: 'self', status: 'PENDING_APPROVAL' },
        { id: 'x', status: 'POSTED', cnSyncStatus: 'SYNCING' },
      ],
      'self',
    );
    expect(hit?.id).toBe('x');
  });
});
