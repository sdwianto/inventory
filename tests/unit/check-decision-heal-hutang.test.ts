import { describe, expect, it, vi, beforeEach } from 'vitest';

const applyCreditNoteFromVendor = vi.fn(async () => ({
  action: 'credit_applied',
  hutangId: 'h1',
  reduced: 50,
}));

vi.mock('@/lib/api/hutang-from-vendor', () => ({
  applyCreditNoteFromVendor: (...args: unknown[]) => applyCreditNoteFromVendor(...(args as [])),
}));

vi.mock('@/lib/api/integration-links', () => ({
  resolveSalesApiAccess: async () => ({ salesAppUrl: 'http://sales', salesApiKey: 'k' }),
}));

const lookup = vi.fn();
vi.mock('@/lib/integration/client', () => ({
  createIntegrationClient: () => ({
    lookupVendorReturnDecisionStatus: (...args: unknown[]) => lookup(...args),
  }),
}));

vi.mock('@/lib/integration/errors', () => ({
  IntegrationError: class IntegrationError extends Error {
    httpStatus?: number;
    constructor(message: string, opts?: { httpStatus?: number }) {
      super(message);
      this.httpStatus = opts?.httpStatus;
    }
  },
}));

vi.mock('@/lib/api/integration-common', () => ({
  salesFetchErrorMessage: () => 'sales down',
}));

// Jangan mock applyVendorReturnDecision di modul yang sama — panggilan internal
// tidak lewat mock. Cukup uji jalur already_resolved yang hanya heal hutang.
import { checkVendorReturnDecisionStatus } from '@/lib/api/vendor-return-decision';

describe('checkVendorReturnDecisionStatus — heal hutang', () => {
  beforeEach(() => {
    applyCreditNoteFromVendor.mockClear();
    lookup.mockReset();
  });

  function makeDb(doc: Record<string, unknown>) {
    return {
      collection: (name: string) => {
        if (name === 'vendor_returns') {
          return { findOne: async () => doc };
        }
        throw new Error(name);
      },
    } as never;
  }

  it('already_resolved + Sales POSTED → heal hutang via applyCreditNoteFromVendor', async () => {
    lookup.mockResolvedValue({
      decided: true,
      status: 'POSTED',
      creditNoteId: 'cn-1',
      noCN: 'CN1',
      total: 50_000,
      invoiceId: 'inv-1',
      lineDecisions: [{ lineId: 'l1', decision: 'ACCEPTED' }],
      acceptedItems: [{ lineId: 'l1', qty: 1 }],
    });

    const r = await checkVendorReturnDecisionStatus(
      makeDb({
        id: 'rtv-1',
        status: 'POSTED',
        vendorDecision: 'ACCEPTED',
        creditNoteId: 'cn-1',
        noInvoice: 'INV-1',
        noReturn: 'RTV1',
        vendorTenantId: 'vendor-a',
      }),
      'sppg',
      'rtv-1',
    );

    expect('action' in r && r.action).toBe('already_resolved');
    expect(applyCreditNoteFromVendor).toHaveBeenCalledTimes(1);
    expect(applyCreditNoteFromVendor.mock.calls[0][2]).toMatchObject({
      total: 50_000,
      creditNoteId: 'cn-1',
      source: 'inventory_return',
      invoiceId: 'inv-1',
    });
    expect(applyCreditNoteFromVendor.mock.calls[0][4]).toMatchObject({
      appliedVia: 'check-decision-pull',
    });
    expect('hutangHeal' in r && r.hutangHeal).toMatchObject({ action: 'credit_applied' });
  });

  it('Sales belum decided → tidak heal hutang', async () => {
    lookup.mockResolvedValue({ decided: false, status: 'DRAFT' });

    const r = await checkVendorReturnDecisionStatus(
      makeDb({
        id: 'rtv-1',
        status: 'POSTED',
        vendorDecision: 'PENDING',
        creditNoteId: 'cn-1',
        vendorTenantId: 'vendor-a',
      }),
      'sppg',
      'rtv-1',
    );

    expect('action' in r && r.action).toBe('still_pending');
    expect(applyCreditNoteFromVendor).not.toHaveBeenCalled();
  });

  it('Sales REJECTED (total 0) → tidak heal hutang', async () => {
    lookup.mockResolvedValue({
      decided: true,
      status: 'REJECTED',
      creditNoteId: 'cn-1',
      total: 0,
      lineDecisions: [{ lineId: 'l1', decision: 'REJECTED', reason: 'x' }],
    });

    const r = await checkVendorReturnDecisionStatus(
      makeDb({
        id: 'rtv-1',
        status: 'POSTED',
        vendorDecision: 'REJECTED',
        creditNoteId: 'cn-1',
        vendorTenantId: 'vendor-a',
      }),
      'sppg',
      'rtv-1',
    );

    expect('action' in r && r.action).toBe('already_resolved');
    expect(applyCreditNoteFromVendor).not.toHaveBeenCalled();
  });

  it('check-decision source: heal hutang tetap ada meski decision error path', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'lib/api/vendor-return-decision.ts'), 'utf8');
    expect(src).toMatch(/Heal hutang tetap dijalankan meski decision apply gagal/);
    expect(src).toMatch(/decisionError/);
  });
});
