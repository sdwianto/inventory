import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  EXECUTION_WAVE_1_TYPES,
  EXECUTION_WAVE_2_TYPES,
  EXECUTION_WAVE_3_TYPES,
  shouldUseExecutionEnqueue,
  shouldUseLegacyBgPoll,
  shouldProcessJobInline,
} from '@/lib/api/execution-wave';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.JOB_BUS_ENABLED = '1';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('execution-wave (EE-9D)', () => {
  it('wave 1 enables only wave-1 types', () => {
    process.env.EXECUTION_WAVE = '1';
    for (const type of EXECUTION_WAVE_1_TYPES) {
      expect(shouldUseExecutionEnqueue(type)).toBe(true);
    }
    for (const type of EXECUTION_WAVE_2_TYPES) {
      expect(shouldUseExecutionEnqueue(type)).toBe(false);
    }
  });

  it('wave 2 enables wave-1 and wave-2 types', () => {
    process.env.EXECUTION_WAVE = '2';
    for (const type of EXECUTION_WAVE_1_TYPES) {
      expect(shouldUseExecutionEnqueue(type)).toBe(true);
    }
    for (const type of EXECUTION_WAVE_2_TYPES) {
      expect(shouldUseExecutionEnqueue(type)).toBe(true);
    }
  });

  it('wave 3 enables wave-1, wave-2, and wave-3 types', () => {
    process.env.EXECUTION_WAVE = '3';
    for (const type of EXECUTION_WAVE_1_TYPES) {
      expect(shouldUseExecutionEnqueue(type)).toBe(true);
    }
    for (const type of EXECUTION_WAVE_2_TYPES) {
      expect(shouldUseExecutionEnqueue(type)).toBe(true);
    }
    for (const type of EXECUTION_WAVE_3_TYPES) {
      expect(shouldUseExecutionEnqueue(type)).toBe(true);
    }
  });

  it('wave 2 does not enable wave-3 types', () => {
    process.env.EXECUTION_WAVE = '2';
    for (const type of EXECUTION_WAVE_3_TYPES) {
      expect(shouldUseExecutionEnqueue(type)).toBe(false);
    }
  });

  it('comma list enables explicit types only', () => {
    process.env.EXECUTION_WAVE = 'GRN_INVOICE_SYNC,WEBHOOK_INBOX';
    process.env.DEPLOYMENT_MODE = 'vps';
    process.env.EXECUTION_LEGACY_BG = '1';
    expect(shouldUseExecutionEnqueue('GRN_INVOICE_SYNC')).toBe(true);
    expect(shouldUseExecutionEnqueue('WEBHOOK_INBOX')).toBe(true);
    expect(shouldUseExecutionEnqueue('CATALOG_SYNC')).toBe(false);
  });

  it('EE-10 VPS enables all wave types without legacy poll', () => {
    process.env.JOB_BUS_ENABLED = '1';
    process.env.DEPLOYMENT_MODE = 'vps';
    process.env.EXECUTION_LEGACY_BG = '0';
    process.env.EXECUTION_WAVE = '0';
    expect(shouldUseLegacyBgPoll()).toBe(false);
    expect(shouldUseExecutionEnqueue('WEBHOOK_INBOX')).toBe(true);
    expect(shouldUseExecutionEnqueue('GRN_INVOICE_SYNC')).toBe(true);
    expect(shouldUseExecutionEnqueue('SANDBOX_RESET')).toBe(true);
    expect(shouldProcessJobInline('PO_VENDOR_SYNC')).toBe(false);
  });

  it('EXECUTION_LEGACY_BG=1 restores wave gating on VPS', () => {
    process.env.DEPLOYMENT_MODE = 'vps';
    process.env.EXECUTION_LEGACY_BG = '1';
    process.env.EXECUTION_WAVE = '1';
    expect(shouldUseLegacyBgPoll()).toBe(true);
    expect(shouldUseExecutionEnqueue('WEBHOOK_INBOX')).toBe(true);
    expect(shouldUseExecutionEnqueue('GRN_INVOICE_SYNC')).toBe(false);
  });
});
