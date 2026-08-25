import { describe, expect, it } from 'vitest';
import { isPoAppliedStatus, canEditPlanMaterials } from '@/lib/food-production/production-plan';

describe('isPoAppliedStatus', () => {
  it('DRAFT and REJECTED are not applied', () => {
    expect(isPoAppliedStatus('DRAFT')).toBe(false);
    expect(isPoAppliedStatus('REJECTED')).toBe(false);
  });

  it('anything else (sent to vendor onward) counts as applied', () => {
    expect(isPoAppliedStatus('SUBMITTED')).toBe(true);
    expect(isPoAppliedStatus('RECEIVED')).toBe(true);
    expect(isPoAppliedStatus('PARTIAL_RECEIVED')).toBe(true);
  });

  it('missing status is not applied', () => {
    expect(isPoAppliedStatus(undefined)).toBe(false);
    expect(isPoAppliedStatus(null)).toBe(false);
  });
});

describe('canEditPlanMaterials (regression guard after isPoAppliedStatus extraction)', () => {
  it('DRAFT/SUBMITTED plan always editable regardless of PO status', () => {
    expect(canEditPlanMaterials('DRAFT', 'RECEIVED')).toBe(true);
    expect(canEditPlanMaterials('SUBMITTED', 'RECEIVED')).toBe(true);
  });

  it('APPROVED plan editable while linked PO still DRAFT/REJECTED or absent', () => {
    expect(canEditPlanMaterials('APPROVED', 'DRAFT')).toBe(true);
    expect(canEditPlanMaterials('APPROVED', 'REJECTED')).toBe(true);
    expect(canEditPlanMaterials('APPROVED', null)).toBe(true);
  });

  it('APPROVED plan locked once linked PO is applied', () => {
    expect(canEditPlanMaterials('APPROVED', 'SUBMITTED')).toBe(false);
    expect(canEditPlanMaterials('APPROVED', 'RECEIVED')).toBe(false);
  });

  it('PROCESSING/COMPLETED plan never editable', () => {
    expect(canEditPlanMaterials('PROCESSING', null)).toBe(false);
    expect(canEditPlanMaterials('COMPLETED', null)).toBe(false);
  });
});
