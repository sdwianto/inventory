import { describe, expect, it } from 'vitest';
import { assertCanApproveInvoice } from '@/lib/api/hutang-approval';
import type { HutangDoc } from '@/types/documents';

function mockDb(po: Record<string, unknown> | null) {
  return {
    collection: (name: string) => ({
      findOne: async () => (name === 'customer_purchase_orders' ? po : null),
    }),
  } as unknown as Parameters<typeof assertCanApproveInvoice>[0];
}

function hutang(overrides: Partial<HutangDoc>): HutangDoc {
  return {
    id: 'h1',
    tenantId: 'default',
    approvalStatus: 'PENDING_REVIEW',
    noPO: 'CPO1',
    ...overrides,
  } as HutangDoc;
}

describe('assertCanApproveInvoice', () => {
  it('blocks approval when PO is PARTIAL_RECEIVED and match is not MATCHED', async () => {
    const db = mockDb({ noPO: 'CPO1', status: 'PARTIAL_RECEIVED' });
    const res = await assertCanApproveInvoice(db, hutang({ matchStatus: 'PENDING' }));
    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe('PO_NOT_RECEIVED');
  });

  it('allows approval when PO is PARTIAL_RECEIVED (rollup drift) but this invoice already MATCHED', async () => {
    // Ini kasus PO CPO2608000025: rollup po.status nyangkut PARTIAL_RECEIVED gara-gara
    // satu baris gagal ter-match di cpo-status-sync, walau 3-way match per-baris invoice
    // (matchStatus) sudah membuktikan semua baris invoice ini didukung GRN POSTED.
    const db = mockDb({ noPO: 'CPO1', status: 'PARTIAL_RECEIVED' });
    const res = await assertCanApproveInvoice(db, hutang({ matchStatus: 'MATCHED' }));
    expect(res.ok).toBe(true);
  });

  it('still allows approval when PO is fully RECEIVED', async () => {
    const db = mockDb({ noPO: 'CPO1', status: 'RECEIVED' });
    const res = await assertCanApproveInvoice(db, hutang({ matchStatus: 'PENDING' }));
    expect(res.ok).toBe(true);
  });

  it('still blocks on MATCH_EXCEPTION even when PO is fully received', async () => {
    const db = mockDb({ noPO: 'CPO1', status: 'RECEIVED' });
    const res = await assertCanApproveInvoice(db, hutang({ matchStatus: 'EXCEPTION', matchError: 'qty mismatch' }));
    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe('MATCH_EXCEPTION');
  });
});
