/**
 * W2-30 — KA Operational Excellence closeout smoke (export presence only).
 * Docs freeze; no mutation behavior asserted here.
 */
import { describe, expect, it } from 'vitest';

import {
  detectKaFollowUpOrphans,
  repairKaFollowUpOrphans,
  runKaFollowUpOrphanDetect,
} from '@/lib/api/ka-follow-up-orphan-reconcile';
import {
  detectKaOpenCaseMissingFu,
  repairKaOpenCaseMissingFu,
  runKaOpenCaseMissingFuDetect,
} from '@/lib/api/ka-open-case-missing-fu-reconcile';
import {
  assertKaCaseTerminalBlockedByActiveFollowUps,
  buildKaResolutionFollowUpStamp,
} from '@/lib/kitchen-assurance/safety-case';

describe('W2-30 KA Operational Excellence closeout smoke', () => {
  it('exports orphan FU Detect / Repair from ka-follow-up-orphan-reconcile', () => {
    expect(typeof detectKaFollowUpOrphans).toBe('function');
    expect(typeof runKaFollowUpOrphanDetect).toBe('function');
    expect(typeof repairKaFollowUpOrphans).toBe('function');
  });

  it('exports missing-FU Detect / Repair from ka-open-case-missing-fu-reconcile', () => {
    expect(typeof detectKaOpenCaseMissingFu).toBe('function');
    expect(typeof runKaOpenCaseMissingFuDetect).toBe('function');
    expect(typeof repairKaOpenCaseMissingFu).toBe('function');
  });

  it('exports terminal gate + pointer stamp helpers from safety-case', () => {
    expect(typeof assertKaCaseTerminalBlockedByActiveFollowUps).toBe('function');
    expect(typeof buildKaResolutionFollowUpStamp).toBe('function');
  });
});
