import { describe, it, expect, vi, beforeEach } from 'vitest';
import { allocateFefo, sortFefo } from '@/lib/food-production/fefo-allocate';
import { effectiveQtyRemaining } from '@/lib/food-production/production-batch';
import { detectFefoBatchMismatches } from '@/lib/api/fefo-batch-reconcile';

vi.mock('@/lib/api/stok-lokasi', () => ({
  getQtyStokLokasi: vi.fn(async () => 5),
}));

describe('W2-1 FEFO allocate', () => {
  it('sorts by expiry ASC then id', () => {
    const sorted = sortFefo([
      { id: 'b', expiryDate: '2026-08-02', qtyRemaining: 1 },
      { id: 'a', expiryDate: '2026-08-01', qtyRemaining: 1 },
      { id: 'c', expiryDate: '2026-08-01', qtyRemaining: 1 },
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  it('allocates earliest expiry first with partial consume', () => {
    const asOf = new Date('2026-07-25T12:00:00.000Z');
    const result = allocateFefo(
      7,
      [
        { id: 'late', batchNo: 'B-LATE', expiryDate: '2026-08-10', qtyRemaining: 10 },
        { id: 'early', batchNo: 'B-EARLY', expiryDate: '2026-08-01', qtyRemaining: 5 },
      ],
      { asOf },
    );
    expect(result.allocated).toBe(7);
    expect(result.shortfall).toBe(0);
    expect(result.allocations).toEqual([
      { batchId: 'early', batchNo: 'B-EARLY', expiryDate: '2026-08-01', qty: 5 },
      { batchId: 'late', batchNo: 'B-LATE', expiryDate: '2026-08-10', qty: 2 },
    ]);
  });

  it('skips expired unless allowExpired', () => {
    const asOf = new Date('2026-07-25T12:00:00.000Z');
    const batches = [
      { id: 'exp', expiryDate: '2026-07-01', qtyRemaining: 100 },
      { id: 'ok', expiryDate: '2026-08-01', qtyRemaining: 3 },
    ];
    const skip = allocateFefo(5, batches, { asOf });
    expect(skip.allocations.map((a) => a.batchId)).toEqual(['ok']);
    expect(skip.shortfall).toBe(2);

    const allow = allocateFefo(5, batches, { asOf, allowExpired: true });
    expect(allow.allocations[0]?.batchId).toBe('exp');
    expect(allow.shortfall).toBe(0);
  });

  it('effectiveQtyRemaining defaults legacy ACTIVE to qty', () => {
    expect(effectiveQtyRemaining({ qty: 12, status: 'ACTIVE' })).toBe(12);
    expect(effectiveQtyRemaining({ qty: 12, status: 'CONSUMED' })).toBe(0);
    expect(effectiveQtyRemaining({ qty: 12, qtyRemaining: 4, status: 'ACTIVE' })).toBe(4);
  });
});

describe('W2-1 FEFO Detect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags expired-with-qty and batch vs stok_lokasi', async () => {
    const batches = [
      {
        id: 'b1',
        batchNo: 'B-1',
        tenantId: 't1',
        expiryDate: '2026-07-01',
        status: 'EXPIRED',
        qty: 10,
        qtyRemaining: 3,
        finishedGoodProductId: 'fg1',
        warehouseKode: 'GKERING',
      },
      {
        id: 'b2',
        batchNo: 'B-2',
        tenantId: 't1',
        expiryDate: '2026-08-01',
        status: 'ACTIVE',
        qty: 10,
        qtyRemaining: 8,
        finishedGoodProductId: 'fg1',
        warehouseKode: 'GKERING',
      },
    ];

    const findCursor = {
      sort: () => findCursor,
      limit: () => findCursor,
      toArray: async () => batches,
    };
    const db = {
      collection: (name: string) => {
        if (name === 'production_batches') {
          return { find: () => findCursor };
        }
        return { find: () => findCursor };
      },
    };

    const report = await detectFefoBatchMismatches(db as never, 't1', {
      asOf: new Date('2026-07-25T12:00:00.000Z'),
    });

    expect(report.summary.expiredWithQty).toBeGreaterThanOrEqual(1);
    expect(report.summary.batchVsStok).toBe(1); // 3+8=11 > stok 5
    expect(report.summary.totalMismatch).toBeGreaterThan(0);
    expect(report.mismatches.some((m) => m.kind === 'EXPIRED_WITH_QTY')).toBe(true);
    expect(report.mismatches.some((m) => m.kind === 'BATCH_VS_STOK_LOKASI')).toBe(true);
  });
});

describe('W2-1 Ops FEFO route', () => {
  it('MASTER POST /ops/fefo-reconcile/run returns summary', async () => {
    vi.resetModules();
    vi.doMock('@/lib/api/require-auth', () => ({
      requireRole: () => null,
    }));
    vi.doMock('@/lib/api/fefo-batch-reconcile', () => ({
      FEFO_RECONCILE_REPORTS_COLLECTION: 'fefo_batch_reconcile_reports',
      runFefoBatchDetect: vi.fn(async () => ({
        id: 'r1',
        tenantId: 't1',
        createdAt: new Date(),
        summary: {
          scannedBatches: 2,
          totalMismatch: 1,
          expiredWithQty: 1,
          activePastExpiry: 0,
          qtyCorruption: 0,
          batchVsStok: 0,
        },
        mismatches: [{ kind: 'EXPIRED_WITH_QTY', detail: 'x' }],
      })),
    }));
    vi.doMock('@/lib/api/health', () => ({ buildHealthResponse: vi.fn() }));
    vi.doMock('@/lib/api/request-metrics', () => ({
      getFpLatencySnapshots: () => [],
      getFpRecentFailures: () => [],
      getFpHotpathSlo: () => null,
    }));
    vi.doMock('@/lib/api/bg-jobs', () => ({
      enqueueJob: vi.fn(),
      scheduleJobProcessing: vi.fn(),
      JOB_TYPES: { INTEGRATION_RECONCILE: 'INTEGRATION_RECONCILE' },
    }));
    vi.doMock('@/lib/api/procurement-repair-run', () => ({ runProcurementRepair: vi.fn() }));
    vi.doMock('@/lib/api/stuck-posting-sweep', () => ({ sweepStuckGrnPosting: vi.fn() }));
    vi.doMock('@/lib/integration/client', () => ({
      createIntegrationClient: () => ({ pingSalesApp: vi.fn() }),
    }));
    vi.doMock('@/lib/api/sales-app-url', () => ({ resolveEffectiveSalesAppUrl: () => '' }));

    const { handleOpsDashboard } = await import('@/lib/api/handlers/ops-dashboard');
    const res = await handleOpsDashboard({
      db: {} as never,
      route: '/ops/fefo-reconcile/run',
      method: 'POST',
      path: ['ops', 'fefo-reconcile', 'run'],
      body: { tenantId: 't1' },
      auth: { role: 'MASTER', isMaster: true, tenantId: 't1', userId: 'u1' },
      request: new Request('http://local/api/ops/fefo-reconcile/run', { method: 'POST' }),
      url: new URL('http://local/api/ops/fefo-reconcile/run'),
    } as never);

    expect(res?.status).toBe(200);
    const json = await res?.json();
    expect(json).toMatchObject({
      reportId: 'r1',
      tenantId: 't1',
      summary: { totalMismatch: 1, expiredWithQty: 1 },
    });
  });
});
