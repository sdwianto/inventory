import { describe, expect, it } from 'vitest';
import { resolveFoodSafetyNextAction } from '@/lib/food-safety/hub-next-action';

describe('resolveFoodSafetyNextAction', () => {
  it('prioritizes open findings / holds', () => {
    const a = resolveFoodSafetyNextAction({
      openCases: 1,
      openFollowUps: 0,
      heldBatches: 0,
      hasActiveHaccpPlan: true,
      auditStatus: 'READY',
    });
    expect(a.mode).toBe('temuan');
    expect(a.href).toBe('/kitchen-assurance/temuan');
  });

  it('asks for setup when no active plan', () => {
    const a = resolveFoodSafetyNextAction({
      openCases: 0,
      openFollowUps: 0,
      heldBatches: 0,
      hasActiveHaccpPlan: false,
      haccpPlanDraftId: 'p1',
      haccpPlanProgressPct: 40,
    });
    expect(a.mode).toBe('setup');
    expect(a.href).toContain('planId=p1');
  });

  it('defaults to operasi when plan active and clear', () => {
    const a = resolveFoodSafetyNextAction({
      openCases: 0,
      openFollowUps: 0,
      heldBatches: 0,
      hasActiveHaccpPlan: true,
      auditStatus: 'READY',
    });
    expect(a.mode).toBe('operasi');
  });

  it('HOLD overrides operasi pending', () => {
    const a = resolveFoodSafetyNextAction({
      openCases: 0,
      openFollowUps: 0,
      heldBatches: 2,
      hasActiveHaccpPlan: true,
      operasiPendingCount: 3,
      auditStatus: 'READY',
    });
    expect(a.mode).toBe('temuan');
    expect(a.href).toBe('/kitchen-assurance/temuan');
  });

  it('operasi pending when plan active and no holds', () => {
    const a = resolveFoodSafetyNextAction({
      openCases: 0,
      openFollowUps: 0,
      heldBatches: 0,
      hasActiveHaccpPlan: true,
      operasiPendingCount: 2,
      auditStatus: 'READY',
    });
    expect(a.mode).toBe('operasi');
    expect(a.href).toBe('/kitchen-assurance/operasi');
    expect(a.title).toMatch(/wajib hari ini/i);
  });

  it('audit CTA names uncovered item count', () => {
    const a = resolveFoodSafetyNextAction({
      openCases: 0,
      openFollowUps: 0,
      heldBatches: 0,
      hasActiveHaccpPlan: true,
      operasiPendingCount: 0,
      auditStatus: 'PARTIAL',
      prpCovered: 4,
      prpTotal: 10,
      extraOpenPillars: 1,
    });
    expect(a.mode).toBe('audit');
    expect(a.href).toBe('/kitchen-assurance/audit');
    expect(a.title).toBe('7 item belum siap audit');
    expect(a.description).toMatch(/7 item belum siap audit/);
  });

  it('audit unreadiness outranks operasi queue so manager CTA can appear', () => {
    const a = resolveFoodSafetyNextAction({
      openCases: 0,
      openFollowUps: 0,
      heldBatches: 0,
      hasActiveHaccpPlan: true,
      operasiPendingCount: 3,
      auditStatus: 'PARTIAL',
      prpCovered: 8,
      prpTotal: 10,
      extraOpenPillars: 1,
    });
    expect(a.mode).toBe('audit');
    expect(a.title).toBe('3 item belum siap audit');
  });
});
