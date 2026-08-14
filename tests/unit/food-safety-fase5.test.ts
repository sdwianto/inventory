/**
 * ADR-004 Fase 5 — HACCP system verification (bukan KA follow-up).
 */
import { describe, expect, it } from 'vitest';
import { assertStatusTransition, FP_DOC_PREFIX, FP_DOC_TYPES } from '@/lib/food-production/document';
import {
  HACCP_VERIFICATION_TRANSITIONS,
  assertHaccpVerificationReady,
  normalizeHaccpVerificationResult,
  normalizeHaccpVerificationType,
} from '@/lib/food-production/haccp-verification';

describe('ADR-004 Fase 5 — document type', () => {
  it('FP_HVER → HVR', () => {
    expect(FP_DOC_TYPES.HACCP_VERIFICATION).toBe('FP_HVER');
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.HACCP_VERIFICATION]).toBe('HVR');
  });
});

describe('ADR-004 Fase 5 — normalize', () => {
  it('type & result', () => {
    expect(normalizeHaccpVerificationType('plan')).toBe('PLAN');
    expect(normalizeHaccpVerificationType('validation')).toBe('VALIDATION');
    expect(normalizeHaccpVerificationType('x')).toEqual({ error: expect.any(String) });
    expect(normalizeHaccpVerificationResult('partial')).toBe('PARTIAL');
  });

  it('VALIDATION butuh haccpPlanId; PARTIAL tanpa evidence OK', () => {
    expect(assertHaccpVerificationReady({
      verificationType: 'VALIDATION',
      method: 'uji dapur',
      result: 'PARTIAL',
      evidenceUrls: [],
    })).toMatch(/haccpPlanId/);

    expect(assertHaccpVerificationReady({
      verificationType: 'VALIDATION',
      method: 'uji dapur',
      result: 'PARTIAL',
      haccpPlanId: 'p1',
      evidenceUrls: [],
    })).toBeNull();
  });
});

describe('ADR-004 Fase 5 — ready gate', () => {
  it('PLAN butuh planId; record butuh resultId', () => {
    expect(assertHaccpVerificationReady({
      verificationType: 'PLAN',
      method: 'review',
      result: 'FAIL',
      evidenceUrls: [],
    })).toMatch(/haccpPlanId/);

    expect(assertHaccpVerificationReady({
      verificationType: 'RECORD_COMPLETENESS',
      method: 'review',
      result: 'FAIL',
      evidenceUrls: [],
    })).toMatch(/haccpResultId/);
  });

  it('PASS butuh evidence', () => {
    expect(assertHaccpVerificationReady({
      verificationType: 'PLAN',
      method: 'desk review',
      result: 'PASS',
      haccpPlanId: 'p1',
      evidenceUrls: [],
    })).toMatch(/Evidence/);

    expect(assertHaccpVerificationReady({
      verificationType: 'PLAN',
      method: 'desk review',
      result: 'PASS',
      haccpPlanId: 'p1',
      evidenceUrls: ['https://example/e1'],
    })).toBeNull();
  });

  it('FAIL tanpa evidence OK jika target ada', () => {
    expect(assertHaccpVerificationReady({
      verificationType: 'CCP_MONITORING',
      method: 'spot check',
      result: 'FAIL',
      haccpResultId: 'r1',
      evidenceUrls: [],
    })).toBeNull();
  });
});

describe('ADR-004 Fase 5 — transitions', () => {
  it('DRAFT → COMPLETED / CANCELLED', () => {
    expect(assertStatusTransition('DRAFT', 'COMPLETED', HACCP_VERIFICATION_TRANSITIONS)).toBeNull();
    expect(assertStatusTransition('DRAFT', 'CANCELLED', HACCP_VERIFICATION_TRANSITIONS)).toBeNull();
    expect(assertStatusTransition('COMPLETED', 'DRAFT', HACCP_VERIFICATION_TRANSITIONS)).toBeTruthy();
  });
});
