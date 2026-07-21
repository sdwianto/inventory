import { describe, expect, it } from 'vitest';
import { isLoopbackSalesUrl, resolveEffectiveSalesAppUrl } from '@/lib/api/sales-app-url';

describe('sales-app-url', () => {
  it('detects loopback URLs', () => {
    expect(isLoopbackSalesUrl('http://localhost:3000')).toBe(true);
    expect(isLoopbackSalesUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackSalesUrl('')).toBe(true);
    expect(isLoopbackSalesUrl('https://sales-dawam.vercel.app')).toBe(false);
  });

  it('prefers env over loopback stored URL', () => {
    const prev = process.env.SALES_APP_URL;
    process.env.SALES_APP_URL = 'https://sales-dawam.vercel.app';
    expect(resolveEffectiveSalesAppUrl('http://localhost:3000')).toBe('https://sales-dawam.vercel.app');
    process.env.SALES_APP_URL = prev;
  });

  it('keeps non-loopback stored URL', () => {
    const prev = process.env.SALES_APP_URL;
    process.env.SALES_APP_URL = 'https://sales-dawam.vercel.app';
    expect(resolveEffectiveSalesAppUrl('https://other.vendor.app')).toBe('https://other.vendor.app');
    process.env.SALES_APP_URL = prev;
  });

  it('on VPS prefers env over stale Vercel stored URL', () => {
    const prevUrl = process.env.SALES_APP_URL;
    const prevMode = process.env.DEPLOYMENT_MODE;
    process.env.DEPLOYMENT_MODE = 'vps';
    process.env.SALES_APP_URL = 'http://sales:3000';
    expect(resolveEffectiveSalesAppUrl('https://penarukan2.vercel.app')).toBe('http://sales:3000');
    process.env.SALES_APP_URL = prevUrl;
    process.env.DEPLOYMENT_MODE = prevMode;
  });
});
