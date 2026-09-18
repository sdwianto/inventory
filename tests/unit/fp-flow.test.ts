import { describe, expect, it } from 'vitest';
import {
  adHocCreateBlockedError,
  formatAdHocCatatan,
  fpFlowStepForPlanStatus,
  isAdHocReasonValid,
  isWeeklyLinkedPlan,
  menuPlanHref,
  planHref,
  productionPlanBodyTouchesComposition,
  weeklyLinkedCompositionLockedError,
} from '@/lib/food-production/fp-flow';

describe('fp-flow handoff', () => {
  it('snaps menu-plan href to Monday weekStart', () => {
    expect(menuPlanHref({ tanggal: '2029-03-05', kitchenId: 'k1' })).toBe(
      '/food-production/menu-plan?weekStart=2029-03-05&kitchenId=k1',
    );
    expect(menuPlanHref({ tanggal: '2029-03-07', kitchenId: 'k1' })).toContain('weekStart=2029-03-05');
  });

  it('builds plan href with productionPlanId and tanggal', () => {
    expect(planHref({ productionPlanId: 'x', tanggal: '2029-03-05' })).toBe(
      '/food-production/plan?productionPlanId=x&tanggal=2029-03-05',
    );
  });

  it('treats cancelled or empty weeklyMenuPlanId as not linked', () => {
    expect(isWeeklyLinkedPlan({ weeklyMenuPlanId: 'w1', status: 'DRAFT' })).toBe(true);
    expect(isWeeklyLinkedPlan({ weeklyMenuPlanId: 'w1', status: 'CANCELLED' })).toBe(false);
    expect(isWeeklyLinkedPlan({ weeklyMenuPlanId: '', status: 'DRAFT' })).toBe(false);
  });

  it('maps RPN status to flow step', () => {
    expect(fpFlowStepForPlanStatus()).toBe('approve');
    expect(fpFlowStepForPlanStatus('DRAFT')).toBe('approve');
    expect(fpFlowStepForPlanStatus('SUBMITTED')).toBe('approve');
    expect(fpFlowStepForPlanStatus('APPROVED')).toBe('fulfill');
    expect(fpFlowStepForPlanStatus('PROCESSING')).toBe('fulfill');
    expect(fpFlowStepForPlanStatus('COMPLETED')).toBe('result');
  });

  it('formats ad-hoc reason and 409 copy', () => {
    expect(isAdHocReasonValid('pendek')).toBe(false);
    expect(isAdHocReasonValid('masak extra posyandu')).toBe(true);
    expect(formatAdHocCatatan('masak extra posyandu')).toBe('ADHOC: masak extra posyandu');
    expect(formatAdHocCatatan('adhoc: masak extra posyandu')).toBe('ADHOC: masak extra posyandu');
    expect(adHocCreateBlockedError({ noDokumen: 'RPN1' })).toMatch(/RPN1/);
    expect(adHocCreateBlockedError(null)).toBeNull();
  });

  it('locks composition fields on weekly-linked PUT', () => {
    expect(productionPlanBodyTouchesComposition({ catatan: 'x' })).toBe(false);
    expect(productionPlanBodyTouchesComposition({ lines: [] })).toBe(true);
    expect(weeklyLinkedCompositionLockedError(true, true)).toMatch(/papan minggu/);
    expect(weeklyLinkedCompositionLockedError(true, false)).toBeNull();
    expect(weeklyLinkedCompositionLockedError(false, true)).toBeNull();
  });
});
