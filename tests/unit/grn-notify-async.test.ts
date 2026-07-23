import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('grn-notify-sales async contract (Fase A + permanent reconcile)', () => {
  const src = readFileSync(
    join(process.cwd(), 'lib/api/grn-notify-sales.ts'),
    'utf8',
  );
  const jobSrc = readFileSync(
    join(process.cwd(), 'lib/api/bg-jobs.ts'),
    'utf8',
  );
  const reconcileSrc = readFileSync(
    join(process.cwd(), 'lib/api/grn-invoice-reconcile.ts'),
    'utf8',
  );
  const recoverSrc = readFileSync(
    join(process.cwd(), 'lib/api/grn-invoice-sync-recover.ts'),
    'utf8',
  );
  const tasksSrc = readFileSync(
    join(process.cwd(), 'lib/execution/scheduler/default-tasks.ts'),
    'utf8',
  );

  it('posts to sales with ?async=1 (not inline)', () => {
    expect(src).toMatch(/\?async=1/);
    expect(src).toMatch(/grn-posted/);
    expect(src).not.toMatch(/\?inline=1/);
  });

  it('does not poll sales bg-jobs on HTTP 202 (hutang via webhook / pull-reconcile)', () => {
    expect(src).not.toMatch(/pollSalesGrnJob/);
    expect(src).not.toMatch(/\/api\/bg-jobs\//);
    expect(src).toMatch(/pending:\s*true/);
    expect(src).toMatch(/salesJobId/);
  });

  it('caps default sync timeout under 15s; preferSync may use 25s', () => {
    expect(src).toMatch(/AbortSignal\.timeout\(10_000\)|AbortSignal\.timeout\(syncTimeoutMs\)/);
    expect(src).toMatch(/preferSync \? 25_000 : 10_000/);
    expect(src).not.toMatch(/AbortSignal\.timeout\(30_000\)/);
    expect(src).not.toMatch(/AbortSignal\.timeout\(45_000\)/);
  });

  it('preferSync skips async fallback that leaves Menunggu faktur', () => {
    expect(src).toMatch(/opts\.preferSync/);
    expect(src).toMatch(/if \(opts\.preferSync\)/);
  });

  it('job path pull-reconciles from Sales before re-notify', () => {
    expect(jobSrc).toMatch(/reconcileGrnInvoiceFromSales/);
    expect(reconcileSrc).toMatch(/customer-invoices|fetchPostedInvoicesFromSalesVendor/);
    expect(reconcileSrc).toMatch(/noDO/);
  });

  it('has background sweeper every 2 minutes', () => {
    expect(recoverSrc).toMatch(/sweepAllStuckGrnInvoiceSyncs/);
    expect(tasksSrc).toMatch(/grn-invoice-sweep:2m/);
    expect(tasksSrc).toMatch(/grnInvoiceSweepOnly:\s*true/);
  });
});
