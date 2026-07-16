import { describe, expect, it } from 'vitest';
import {
  buildPurchaseLinesFromMrp,
  summarizePurchaseLines,
  toDraftCpoItemPayloads,
  canRecreateDraftCpo,
  isLinkedCpoSupersedable,
  PR_ELIGIBLE_MRP_STATUSES,
  PR_ACTIVE_STATUSES,
  isPrEditable,
} from '@/lib/food-production/purchase-requirement';
import { FP_DOC_PREFIX, FP_DOC_TYPES, assertStatusTransition } from '@/lib/food-production/document';

describe('food-production sprint 5 — Purchase Requirement', () => {
  it('uses PRB document prefix', () => {
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.PURCHASE_REQUIREMENT]).toBe('PRB');
  });

  it('only accepts APPROVED MRP', () => {
    expect(PR_ELIGIBLE_MRP_STATUSES.has('APPROVED')).toBe(true);
    expect(PR_ELIGIBLE_MRP_STATUSES.has('DRAFT')).toBe(false);
    expect(PR_ELIGIBLE_MRP_STATUSES.has('SUBMITTED')).toBe(false);
  });

  it('tracks active PR statuses that block duplicates', () => {
    expect(PR_ACTIVE_STATUSES).toContain('SUBMITTED');
    expect(PR_ACTIVE_STATUSES).toContain('APPROVED');
    expect(PR_ACTIVE_STATUSES).toContain('PROCESSING');
    expect(PR_ACTIVE_STATUSES).not.toContain('DRAFT');
  });

  it('builds purchase lines only from finite shortages', () => {
    const lines = buildPurchaseLinesFromMrp([
      {
        productId: 'beras',
        productKode: 'B001',
        productNama: 'Beras',
        satuan: 'KG',
        qtyGross: 20,
        qtyOnHand: 15,
        qtyNet: 5,
        shortage: true,
      },
      {
        productId: 'garam',
        productKode: 'G001',
        productNama: 'Garam',
        satuan: 'KG',
        qtyGross: 1,
        qtyOnHand: 2,
        qtyNet: 0,
        shortage: false,
      },
      {
        productId: 'bad',
        qtyNet: Number.NaN,
        qtyGross: 10,
        qtyOnHand: 0,
        shortage: true,
      },
      {
        productId: '',
        qtyNet: 10,
        qtyGross: 10,
        qtyOnHand: 0,
        shortage: true,
      },
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0].productId).toBe('beras');
    expect(lines[0].qtyNet).toBe(5);
    expect(lines[0].qtyOnHand).toBe(15);

    const summary = summarizePurchaseLines(lines);
    expect(summary.lineCount).toBe(1);
    expect(summary.qtyNetTotal).toBe(5);
  });

  it('maps PR lines to Draft CPO payloads', () => {
    const payloads = toDraftCpoItemPayloads([
      {
        productId: 'beras',
        productKode: 'B001',
        productNama: 'Beras',
        satuan: 'KG',
        qtyNet: 5,
      },
    ]);
    expect(payloads).toEqual([
      {
        localStokId: 'beras',
        qty: 5,
        satuan: 'KG',
        nama: 'Beras',
        kode: 'B001',
        estimasiHarga: 0,
      },
    ]);
  });

  it('allows recreate Draft CPO when missing or cancelled', () => {
    expect(canRecreateDraftCpo('DRAFT', null)).toBe(true);
    expect(canRecreateDraftCpo('DRAFT', 'MISSING')).toBe(true);
    expect(canRecreateDraftCpo('DRAFT', 'CANCELLED')).toBe(true);
    expect(canRecreateDraftCpo('APPROVED', 'CANCELLED')).toBe(true);
    expect(canRecreateDraftCpo('DRAFT', 'DRAFT')).toBe(false);
    expect(canRecreateDraftCpo('DRAFT', 'APPROVED')).toBe(false);
    expect(canRecreateDraftCpo('CANCELLED', 'CANCELLED')).toBe(false);
    expect(canRecreateDraftCpo('COMPLETED', null)).toBe(false);
  });

  it('blocks supersede when linked CPO already advanced', () => {
    expect(isLinkedCpoSupersedable(null)).toBe(true);
    expect(isLinkedCpoSupersedable('MISSING')).toBe(true);
    expect(isLinkedCpoSupersedable('DRAFT')).toBe(true);
    expect(isLinkedCpoSupersedable('CANCELLED')).toBe(true);
    expect(isLinkedCpoSupersedable('PENDING_APPROVAL')).toBe(false);
    expect(isLinkedCpoSupersedable('APPROVED')).toBe(false);
    expect(isLinkedCpoSupersedable('SUBMITTED')).toBe(false);
  });

  it('PR editable statuses match Draft/Submitted', () => {
    expect(isPrEditable('DRAFT')).toBe(true);
    expect(isPrEditable('SUBMITTED')).toBe(true);
    expect(isPrEditable('APPROVED')).toBe(false);
  });

  it('allows cancel from active lifecycle statuses', () => {
    expect(assertStatusTransition('DRAFT', 'CANCELLED')).toBeNull();
    expect(assertStatusTransition('SUBMITTED', 'CANCELLED')).toBeNull();
    expect(assertStatusTransition('APPROVED', 'CANCELLED')).toBeNull();
    expect(assertStatusTransition('COMPLETED', 'CANCELLED')).toBeTruthy();
  });
});
