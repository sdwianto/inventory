import { afterEach, describe, expect, it } from 'vitest';
import { shouldWarmUpSalesApp } from '@/lib/api/customer-po-push';

describe('shouldWarmUpSalesApp', () => {
  const prevMode = process.env.DEPLOYMENT_MODE;

  afterEach(() => {
    if (prevMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = prevMode;
  });

  it('skips warm-up on VPS', () => {
    process.env.DEPLOYMENT_MODE = 'vps';
    expect(shouldWarmUpSalesApp('https://sales-dawam.vercel.app')).toBe(false);
  });

  it('skips warm-up for docker service hostname', () => {
    delete process.env.DEPLOYMENT_MODE;
    expect(shouldWarmUpSalesApp('http://sales:3000')).toBe(false);
    expect(shouldWarmUpSalesApp('http://localhost:3000')).toBe(false);
  });

  it('keeps warm-up for public Vercel host outside VPS', () => {
    delete process.env.DEPLOYMENT_MODE;
    expect(shouldWarmUpSalesApp('https://sales-dawam.vercel.app')).toBe(true);
  });
});
