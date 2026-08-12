/**
 * ADR-004 Fase 3 — HACCP Study Plan (structured critical limits + approval gate).
 */
import { describe, expect, it } from 'vitest';
import { assertStatusTransition, FP_DOC_PREFIX, FP_DOC_TYPES } from '@/lib/food-production/document';
import {
  EXAMPLE_HACCP_PLAN_COOK,
  HACCP_PLAN_TRANSITIONS,
  assertHaccpPlanReadyForApproval,
  formatCriticalLimit,
  normalizeHaccpPlanEmbedded,
  parseCriticalLimitNote,
} from '@/lib/food-production/haccp-plan';

describe('ADR-004 Fase 3 — document type', () => {
  it('FP_HPLAN → prefix HPL', () => {
    expect(FP_DOC_TYPES.HACCP_PLAN).toBe('FP_HPLAN');
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.HACCP_PLAN]).toBe('HPL');
  });
});

describe('ADR-004 Fase 3 — parseCriticalLimitNote', () => {
  it('parse ≥ 74°C → GTE', () => {
    const cl = parseCriticalLimitNote('≥ 74°C', { key: 'cl1', parameter: 'core_temp' });
    expect(cl.operator).toBe('GTE');
    expect(cl.value).toBe(74);
    expect(cl.unit).toBe('C');
  });

  it('parse <= 5 C → LTE', () => {
    const cl = parseCriticalLimitNote('<= 5 C');
    expect(cl.operator).toBe('LTE');
    expect(cl.value).toBe(5);
  });

  it('parse between range', () => {
    const cl = parseCriticalLimitNote('2-4 jam');
    expect(cl.operator).toBe('BETWEEN');
    expect(cl.value).toBe(2);
    expect(cl.valueMax).toBe(4);
  });

  it('teks bebas → TEXT', () => {
    const cl = parseCriticalLimitNote('sesuai SOP dapur');
    expect(cl.operator).toBe('TEXT');
    expect(cl.note).toBe('sesuai SOP dapur');
  });
});

describe('ADR-004 Fase 3 — normalize embedded + approval', () => {
  it('normalize contoh plan tanpa error', () => {
    const emb = normalizeHaccpPlanEmbedded(EXAMPLE_HACCP_PLAN_COOK);
    expect('error' in emb).toBe(false);
    if ('error' in emb) return;
    expect(emb.processSteps.length).toBeGreaterThanOrEqual(3);
    expect(emb.ccps).toHaveLength(1);
    expect(emb.criticalLimits[0]?.operator).toBe('GTE');
  });

  it('ccpJustification wajib bila isCcp', () => {
    const emb = normalizeHaccpPlanEmbedded({
      processSteps: [{ key: 'cook', nama: 'Masak', sequence: 1 }],
      hazards: [{
        key: 'hz1',
        processStepKey: 'cook',
        hazardType: 'BIOLOGICAL',
        description: 'Patogen',
        isCcp: true,
      }],
      ccps: [],
      criticalLimits: [],
    });
    expect(emb).toEqual({ error: expect.stringContaining('ccpJustification') });
  });

  it('approval gate menolak plan kosong', () => {
    expect(assertHaccpPlanReadyForApproval({
      processSteps: [],
      hazards: [],
      ccps: [],
      criticalLimits: [],
      monitoringPlans: [],
    })).toMatch(/process step/i);
  });

  it('approval gate menolak tanpa monitoring plan', () => {
    const { monitoringPlans: _m, ...rest } = EXAMPLE_HACCP_PLAN_COOK;
    expect(assertHaccpPlanReadyForApproval({
      ...rest,
      monitoringPlans: [],
    })).toMatch(/monitoring/i);
  });

  it('approval gate lulus untuk contoh cook', () => {
    expect(assertHaccpPlanReadyForApproval(EXAMPLE_HACCP_PLAN_COOK)).toBeNull();
  });

  it('contoh cook berlabel isExample', () => {
    expect(EXAMPLE_HACCP_PLAN_COOK.isExample).toBe(true);
  });

  it('ACTIVE supersede: transisi APPROVED→ACTIVE diizinkan; dua ACTIVE dicegah di index/handler', () => {
    expect(assertStatusTransition('APPROVED', 'ACTIVE', HACCP_PLAN_TRANSITIONS)).toBeNull();
    expect(assertStatusTransition('ACTIVE', 'SUPERSEDED', HACCP_PLAN_TRANSITIONS)).toBeNull();
  });

  it('formatCriticalLimit GTE', () => {
    expect(formatCriticalLimit({
      key: 'x',
      parameter: 't',
      label: 'Suhu',
      operator: 'GTE',
      value: 74,
      unit: 'C',
    })).toBe('≥ 74 C');
  });
});

describe('ADR-004 Fase 3 — status transitions', () => {
  it('DRAFT → UNDER_REVIEW → APPROVED → ACTIVE', () => {
    expect(assertStatusTransition('DRAFT', 'UNDER_REVIEW', HACCP_PLAN_TRANSITIONS)).toBeNull();
    expect(assertStatusTransition('UNDER_REVIEW', 'APPROVED', HACCP_PLAN_TRANSITIONS)).toBeNull();
    expect(assertStatusTransition('APPROVED', 'ACTIVE', HACCP_PLAN_TRANSITIONS)).toBeNull();
    expect(assertStatusTransition('DRAFT', 'ACTIVE', HACCP_PLAN_TRANSITIONS)).toBeTruthy();
    expect(assertStatusTransition('ACTIVE', 'DRAFT', HACCP_PLAN_TRANSITIONS)).toBeTruthy();
  });
});
