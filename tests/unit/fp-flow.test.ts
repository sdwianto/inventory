import { describe, expect, it } from 'vitest';
import {
  adHocCreateBlockedError,
  canReviseApprovedMenu,
  formatAdHocCatatan,
  formatMenuReviseHistoryNote,
  fpFlowStepForPlanStatus,
  isAdHocReasonValid,
  isWeeklyLinkedPlan,
  menuPlanHref,
  menuReviseNeedsRepublish,
  planHref,
  productionPlanBodyTouchesComposition,
  reviseMenuKitchenScopeError,
  reviseMenuOperationalBlockError,
  reviseMenuProcureWarningLines,
  reviseMenuReasonError,
  WEEKLY_MENU_PUBLISH_NOTE,
  weeklyLinkedCompositionLockedError,
  weeklyLinkedDraftRevertError,
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

  it('allows menu revise only on APPROVED with a real reason', () => {
    expect(canReviseApprovedMenu('APPROVED')).toBe(true);
    expect(canReviseApprovedMenu('SUBMITTED')).toBe(false);
    expect(canReviseApprovedMenu('DRAFT')).toBe(false);
    expect(canReviseApprovedMenu('PROCESSING')).toBe(false);
    expect(canReviseApprovedMenu('COMPLETED')).toBe(false);
    expect(reviseMenuReasonError('pendek')).toMatch(/minimal 8/i);
    expect(reviseMenuReasonError('bahan serai habis di pasar')).toBeNull();
    expect(formatMenuReviseHistoryNote('bahan serai habis di pasar')).toBe(
      'REVISI MENU: bahan serai habis di pasar',
    );
  });

  it('warns about downstream MRP/PR/PO without implying auto-rewrite', () => {
    expect(reviseMenuProcureWarningLines({})[0]).toMatch(/Belum ada MRP/);
    const withPo = reviseMenuProcureWarningLines({
      mrpNo: 'KBH1',
      mrpStatus: 'APPROVED',
      prNo: 'PRB1',
      prStatus: 'APPROVED',
      poNo: 'CPO1',
      poStatus: 'SUBMITTED',
    });
    expect(withPo.join(' ')).toMatch(/KBH1/);
    expect(withPo.join(' ')).toMatch(/PRB1/);
    expect(withPo.join(' ')).toMatch(/tidak diubah otomatis/);
    expect(withPo.join(' ')).toMatch(/amandemen manual/);
    expect(withPo.join(' ')).toMatch(/terblokir sampai PR dibatalkan/);
    const draftPo = reviseMenuProcureWarningLines({ poNo: 'CPO2', poStatus: 'DRAFT' });
    expect(draftPo.join(' ')).toMatch(/masih draft/);
    const donePr = reviseMenuProcureWarningLines({ prNo: 'PRB2', prStatus: 'COMPLETED' });
    expect(donePr.join(' ')).not.toMatch(/terblokir/);
  });

  it('blocks revise when stock already moved, and requires republish before re-approve', () => {
    expect(reviseMenuOperationalBlockError({ status: 'APPROVED' })).toBeNull();
    expect(reviseMenuOperationalBlockError({ status: 'APPROVED', issueNo: 'PBL1' })).toMatch(/dikeluarkan/);
    expect(reviseMenuOperationalBlockError({ status: 'APPROVED', resultNo: 'HSL1' })).toMatch(/hasil produksi/);
    expect(reviseMenuKitchenScopeError('k1', 'k2')).toMatch(/dapur/);
    expect(reviseMenuKitchenScopeError('k1', 'k1')).toBeNull();
    expect(reviseMenuKitchenScopeError('k1', '')).toBeNull();

    const revised = [
      { fromStatus: 'SUBMITTED', toStatus: 'APPROVED', note: 'ok' },
      { fromStatus: 'APPROVED', toStatus: 'SUBMITTED', note: 'REVISI MENU: bahan serai habis' },
    ];
    expect(menuReviseNeedsRepublish(revised)).toBe(true);
    expect(menuReviseNeedsRepublish([
      ...revised,
      { fromStatus: 'SUBMITTED', toStatus: 'SUBMITTED', note: WEEKLY_MENU_PUBLISH_NOTE },
    ])).toBe(false);
    expect(weeklyLinkedDraftRevertError({
      weeklyMenuPlanId: 'w1',
      status: 'SUBMITTED',
      history: revised,
    })).toMatch(/tidak dikembalikan ke Draft/);
    expect(weeklyLinkedDraftRevertError({
      weeklyMenuPlanId: 'w1',
      status: 'SUBMITTED',
      history: [{ fromStatus: 'DRAFT', toStatus: 'SUBMITTED' }],
    })).toBeNull();
  });
});
