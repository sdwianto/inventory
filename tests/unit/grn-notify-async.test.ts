import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('grn-notify-sales P0 sync contract (no soft-async happy path)', () => {
  const src = readFileSync(
    join(process.cwd(), 'lib/api/grn-notify-sales.ts'),
    'utf8',
  );
  const clientSrc = readFileSync(
    join(process.cwd(), 'lib/integration/client.ts'),
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

  it('uses IntegrationClient + v1 grn-posted (no ?async=1)', () => {
    expect(src).toMatch(/createIntegrationClient|IntegrationClient/);
    expect(src).not.toMatch(/\?async=1/);
    expect(clientSrc).toMatch(/\/api\/v1\/integrations\/grn-posted/);
    expect(clientSrc).not.toMatch(/\?async=1/);
  });

  it('does not poll sales bg-jobs', () => {
    expect(src).not.toMatch(/pollSalesGrnJob/);
    expect(src).not.toMatch(/\/api\/bg-jobs\//);
  });

  it('Category A timeout owned by Transport (35s)', () => {
    expect(src).toMatch(/timeoutMs:\s*35_000/);
    expect(clientSrc).toMatch(/35_000/);
  });

  it('job path pull-reconciles from Sales before re-notify', () => {
    expect(jobSrc).toMatch(/reconcileGrnInvoiceFromSales/);
    expect(reconcileSrc).toMatch(/customer-invoices|fetchPostedInvoicesFromSalesVendor/);
    expect(reconcileSrc).toMatch(/noDO/);
  });

  it('treats legacy pending/async as FAILED (no soft PENDING happy path)', () => {
    expect(jobSrc).toMatch(/tidak diizinkan Category A/);
    expect(jobSrc).not.toMatch(/GRN_INVOICE_MAX_SOFT_ATTEMPTS/);
  });

  it('grn-post always syncs invoice inline (no PENDING enqueue happy path)', () => {
    const postSrc = readFileSync(join(process.cwd(), 'lib/api/grn-post.ts'), 'utf8');
    expect(postSrc).toMatch(/syncInvoiceInline = canSyncInvoice/);
    expect(postSrc).toMatch(/asyncInvoice diabaikan/);
    expect(postSrc).toMatch(/Buat faktur — sync Category A/);
    expect(postSrc).not.toMatch(/forceVpsInline/);
  });

  it('has background sweeper every 2 minutes (recovery)', () => {
    expect(recoverSrc).toMatch(/sweepAllStuckGrnInvoiceSyncs/);
    expect(tasksSrc).toMatch(/grn-invoice-sweep:2m/);
    expect(tasksSrc).toMatch(/grnInvoiceSweepOnly:\s*true/);
  });
});
