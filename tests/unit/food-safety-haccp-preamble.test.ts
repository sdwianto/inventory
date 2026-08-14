import { describe, expect, it } from 'vitest';
import {
  assertHaccpPlanReadyForApproval,
  normalizeHaccpTeam,
  EXAMPLE_HACCP_PLAN_COOK,
} from '@/lib/food-production/haccp-plan';
import { preambleChecklist, emptyPreamble } from '@/components/food-safety/HaccpPreamblePanels';
import { studyChecklist } from '@/components/food-production/HaccpStudyForm';

describe('HACCP preamble 8.1–8.5', () => {
  it('normalizeHaccpTeam rejects incomplete member', () => {
    expect(normalizeHaccpTeam([{ name: 'A', role: '' }])).toEqual({
      error: expect.stringContaining('nama dan peran'),
    });
  });

  it('normalizeHaccpTeam keeps valid members', () => {
    const t = normalizeHaccpTeam([
      { name: 'Ani', role: 'Ketua', unit: 'Mutu' },
      { name: '', role: '' },
    ]);
    expect(t).toEqual([{ name: 'Ani', role: 'Ketua', unit: 'Mutu' }]);
  });

  it('preambleChecklist tracks completeness', () => {
    const empty = preambleChecklist(emptyPreamble(), 0);
    expect(empty.every((c) => !c.ok)).toBe(true);
    const filled = preambleChecklist({
      team: [{ name: 'A', role: 'Ketua' }],
      scope: 'Dapur X',
      productDescription: 'Nasi',
      intendedUse: 'Anak sekolah',
      recipeIdsCsv: '',
      menuIdsCsv: '',
      flowDiagramNote: '',
      flowDiagramUrls: [],
      flowVerified: true,
      flowVerifiedByName: 'Budi',
      flowVerifiedNote: '',
    }, 3);
    expect(filled.every((c) => c.ok)).toBe(true);
  });

  it('example plan includes preamble fields', () => {
    expect(EXAMPLE_HACCP_PLAN_COOK.team?.length).toBeGreaterThan(0);
    expect(EXAMPLE_HACCP_PLAN_COOK.scope).toBeTruthy();
    expect(EXAMPLE_HACCP_PLAN_COOK.flowVerifiedAt).toBeTruthy();
    expect(assertHaccpPlanReadyForApproval(EXAMPLE_HACCP_PLAN_COOK)).toBeNull();
  });

  it('studyChecklist tracks D completeness', () => {
    expect(studyChecklist({
      processSteps: [],
      hazards: [],
      ccps: [],
      criticalLimits: [],
      monitoringPlans: [],
    }).every((c) => !c.ok)).toBe(true);
    expect(studyChecklist({
      processSteps: [{ key: 'cook', nama: 'Masak', sequence: 1 }],
      hazards: [{
        key: 'h1',
        processStepKey: 'cook',
        hazardType: 'BIOLOGICAL',
        description: 'kuman',
        isCcp: true,
        ccpJustification: 'suhu',
      }],
      ccps: [{
        key: 'c1',
        processStepKey: 'cook',
        hazardKeys: ['h1'],
        nama: 'Suhu inti',
        correctiveAction: 'Masak ulang',
      }],
      criticalLimits: [{
        key: 'l1',
        ccpKey: 'c1',
        parameter: 'suhu',
        label: '74C',
        operator: 'GTE',
        value: 74,
        unit: 'C',
      }],
      monitoringPlans: [{
        key: 'm1',
        ccpKey: 'c1',
        method: 'Termometer',
        frequency: 'tiap batch',
        criticalLimitKeys: ['l1'],
      }],
    }).every((c) => c.ok)).toBe(true);
  });
});
