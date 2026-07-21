import { describe, expect, it } from 'vitest';
import {
  GRN_INVOICE_PENDING_STALE_MS,
  grnInvoiceSyncWaitMs,
  isGrnInvoiceSyncStale,
} from '@/lib/api/grn-invoice-sync-recover';

describe('grn-invoice-sync-recover', () => {
  it('detects stale PENDING wait', () => {
    const now = Date.now();
    const fresh = {
      id: 'g1',
      invoiceSyncStatus: 'PENDING',
      invoiceSyncAt: new Date(now - 30_000),
    };
    const stale = {
      id: 'g2',
      invoiceSyncStatus: 'PENDING',
      invoiceSyncAt: new Date(now - GRN_INVOICE_PENDING_STALE_MS - 1_000),
    };
    expect(isGrnInvoiceSyncStale(fresh, now)).toBe(false);
    expect(isGrnInvoiceSyncStale(stale, now)).toBe(true);
    expect(grnInvoiceSyncWaitMs(stale, now)).toBeGreaterThanOrEqual(GRN_INVOICE_PENDING_STALE_MS);
  });

  it('ignores DONE or rows with noInvoice', () => {
    const now = Date.now();
    expect(isGrnInvoiceSyncStale({
      invoiceSyncStatus: 'DONE',
      invoiceSyncAt: new Date(now - 10 * 60_000),
    }, now)).toBe(false);
    expect(isGrnInvoiceSyncStale({
      invoiceSyncStatus: 'PENDING',
      noInvoice: 'INV1',
      invoiceSyncAt: new Date(now - 10 * 60_000),
    }, now)).toBe(false);
  });
});
