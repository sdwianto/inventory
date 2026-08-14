import { describe, expect, it } from 'vitest';
import {
  auditPillarHref,
  buildHaccpWizardHref,
  countAuditOpenItems,
} from '@/lib/food-safety/audit-links';
import { HACCP_RECORDS_POINTERS } from '@/lib/food-safety/haccp-records-pointers';
import { HACCP_VERIFICATION_TYPE_LABELS } from '@/lib/food-production/haccp-verification';
import {
  haccpPlanAllowsCloseoutEdit,
  haccpPlanAllowsStudyEdit,
  hasHaccpPlanValidation,
  hasHaccpTrainingEvidence,
} from '@/lib/food-production/haccp-plan';

describe('Gelombang E — wizard closeout & audit links', () => {
  it('wizard E deep-link includes step', () => {
    expect(buildHaccpWizardHref({ planId: 'p1', step: 'E' })).toBe(
      '/food-production/haccp-plan?planId=p1&step=E',
    );
  });

  it('pillar merah mengarah ke Setup / Operasi / Temuan / Wizard E', () => {
    expect(auditPillarHref('bgn_prp')).toBe('/kitchen-assurance/setup');
    expect(auditPillarHref('open_holds')).toBe('/kitchen-assurance/temuan');
    expect(auditPillarHref('haccp_fail_window')).toBe('/kitchen-assurance/operasi');
    expect(auditPillarHref('haccp_verification', { planId: 'p9' })).toContain('step=E');
    expect(auditPillarHref('haccp_verification', { planId: 'p9' })).toContain('planId=p9');
    expect(auditPillarHref('haccp_training', { planId: 'p9' })).toContain('step=E');
  });

  it('countAuditOpenItems = PRP gap + pilar lain', () => {
    expect(countAuditOpenItems({ prpCovered: 2, prpTotal: 5, extraOpenPillars: 2 })).toBe(5);
    expect(countAuditOpenItems({})).toBe(0);
  });

  it('records pointers cover CCP, suhu, PRP, temuan, verifikasi', () => {
    const keys = HACCP_RECORDS_POINTERS.map((r) => r.key);
    expect(keys).toEqual(['ccp', 'temp', 'prp', 'temuan', 'verify']);
    expect(HACCP_RECORDS_POINTERS.find((r) => r.key === 'prp')?.href).toBe('/kitchen-assurance/setup');
    expect(HACCP_RECORDS_POINTERS.find((r) => r.key === 'verify')?.href).toContain('step=E');
  });

  it('VALIDATION is a first-class verification type', () => {
    expect(HACCP_VERIFICATION_TYPE_LABELS.VALIDATION).toMatch(/validasi/i);
  });

  it('closeout E boleh diisi pada plan ACTIVE; studi tidak', () => {
    expect(haccpPlanAllowsStudyEdit('ACTIVE')).toBe(false);
    expect(haccpPlanAllowsCloseoutEdit('ACTIVE')).toBe(true);
    expect(haccpPlanAllowsCloseoutEdit('SUPERSEDED')).toBe(false);
  });

  it('hasHaccpPlanValidation / training dari bukti lean', () => {
    expect(hasHaccpPlanValidation(null)).toBe(false);
    expect(hasHaccpPlanValidation({ validationNote: 'uji 74C' })).toBe(true);
    expect(hasHaccpTrainingEvidence({ trainingEvidenceUrls: ['https://x/p.jpg'] })).toBe(true);
    expect(hasHaccpTrainingEvidence({ trainingNote: '' })).toBe(false);
  });
});
