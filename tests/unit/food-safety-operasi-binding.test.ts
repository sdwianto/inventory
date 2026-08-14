/**
 * Gelombang C — binding Operasi ↔ plan + template kode hint.
 */
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_HACCP_PLAN_COOK,
  assertHaccpPlanReadyForApproval,
  normalizeHaccpPlanEmbedded,
  normalizeHaccpTemplateKodeHint,
} from '@/lib/food-production/haccp-plan';
import {
  buildOperasiCcpQueue,
  buildOperasiSupportQueue,
} from '@/lib/food-safety/operasi-queue';
import { buildHaccpHoldRepairHrefs } from '@/lib/food-safety/hold-repair-href';

describe('normalizeHaccpTemplateKodeHint', () => {
  it('maps legacy HACCP-COOK → HCP-COOK', () => {
    expect(normalizeHaccpTemplateKodeHint('HACCP-COOK')).toBe('HCP-COOK');
    expect(normalizeHaccpTemplateKodeHint('haccp-cool')).toBe('HCP-COOL');
    expect(normalizeHaccpTemplateKodeHint('HCP-HOLD')).toBe('HCP-HOLD');
  });

  it('persist monitoringPlans menormalkan HACCP-COOK → HCP-COOK', () => {
    const emb = normalizeHaccpPlanEmbedded({
      ...EXAMPLE_HACCP_PLAN_COOK,
      monitoringPlans: EXAMPLE_HACCP_PLAN_COOK.monitoringPlans.map((m) => ({
        ...m,
        templateKodeHint: 'HACCP-COOK',
      })),
    });
    expect('error' in emb).toBe(false);
    if ('error' in emb) return;
    expect(emb.monitoringPlans[0]?.templateKodeHint).toBe('HCP-COOK');
  });
});

describe('buildHaccpHoldRepairHrefs', () => {
  it('Temuan + follow-up upload dalam satu case/batch', () => {
    const hrefs = buildHaccpHoldRepairHrefs({
      caseId: 'case-1',
      batchId: 'batch-1',
      followUpId: 'fu-1',
    });
    expect(hrefs.temuanHref).toContain('/kitchen-assurance/temuan');
    expect(hrefs.temuanHref).toContain('caseId=case-1');
    expect(hrefs.temuanHref).toContain('batch=batch-1');
    expect(hrefs.followUpHref).toContain('/kitchen-assurance/follow-up');
    expect(hrefs.followUpHref).toContain('caseId=case-1');
    expect(hrefs.followUpHref).toContain('upload=1');
    expect(hrefs.followUpHref).toContain('followUpId=fu-1');
  });
});

describe('assertHaccpPlanReadyForApproval — correctiveAction', () => {
  it('menolak CCP tanpa tindakan korektif', () => {
    const plan = {
      ...EXAMPLE_HACCP_PLAN_COOK,
      ccps: EXAMPLE_HACCP_PLAN_COOK.ccps.map((c) => ({ ...c, correctiveAction: '' })),
    };
    expect(assertHaccpPlanReadyForApproval(plan)).toMatch(/correctiveAction|korektif/i);
  });

  it('lulus contoh cook (punya correctiveAction)', () => {
    expect(assertHaccpPlanReadyForApproval(EXAMPLE_HACCP_PLAN_COOK)).toBeNull();
  });
});

describe('buildOperasiCcpQueue', () => {
  it('membangun deep-link create dengan planId + ccpKey + templateKode', () => {
    const withId = buildOperasiCcpQueue({
      id: 'plan-1',
      monitoringPlans: EXAMPLE_HACCP_PLAN_COOK.monitoringPlans,
      ccps: EXAMPLE_HACCP_PLAN_COOK.ccps,
    });
    expect(withId).toHaveLength(1);
    expect(withId[0]?.href).toContain('create=1');
    expect(withId[0]?.href).toContain('planId=plan-1');
    expect(withId[0]?.href).toContain('ccpKey=ccp_cook_temp');
    expect(withId[0]?.href).toContain('templateKode=HCP-COOK');
    expect(withId[0]?.title).toMatch(/suhu inti/i);
  });

  it('support queue punya suhu + PRP', () => {
    const support = buildOperasiSupportQueue();
    expect(support.map((s) => s.kind).sort()).toEqual(['prp', 'temp']);
    expect(support.find((s) => s.kind === 'prp')?.href).toBe('/kitchen-assurance/setup');
  });
});
