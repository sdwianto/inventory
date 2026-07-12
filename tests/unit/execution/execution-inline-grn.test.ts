import { describe, expect, it, afterEach } from 'vitest';
import { shouldProcessGrnJobInline } from '@/lib/api/execution-inline-grn';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('execution-inline-grn (EE-9D)', () => {
  it('VPS defaults to async enqueue (no inline)', () => {
    process.env.DEPLOYMENT_MODE = 'vps';
    process.env.JOB_BUS_ENABLED = '1';
    process.env.EXECUTION_LEGACY_BG = '0';
    delete process.env.EXECUTION_INLINE_GRN;
    delete process.env.VERCEL;
    expect(shouldProcessGrnJobInline()).toBe(false);
  });

  it('EXECUTION_INLINE_GRN=1 forces inline', () => {
    process.env.DEPLOYMENT_MODE = 'vps';
    process.env.EXECUTION_INLINE_GRN = '1';
    expect(shouldProcessGrnJobInline()).toBe(true);
  });

  it('non-VPS defaults to inline', () => {
    process.env.DEPLOYMENT_MODE = 'serverless';
    delete process.env.EXECUTION_INLINE_GRN;
    delete process.env.VERCEL;
    expect(shouldProcessGrnJobInline()).toBe(true);
  });
});
