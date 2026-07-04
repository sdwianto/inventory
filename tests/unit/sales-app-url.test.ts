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
});
