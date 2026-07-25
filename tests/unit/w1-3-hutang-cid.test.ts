/**
 * W1-3 slice 1: hutang CID stamp + invoice-posted header + ReceiveInvoicePosted command log.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('W1-3 hutang CID (Inventory)', () => {
  it('invoice-posted requires X-Correlation-Id and logs ReceiveInvoicePosted', () => {
    const src = readFileSync(
      join(process.cwd(), 'lib/api/handlers/integration-inbound.ts'),
      'utf8',
    );
    expect(src).toMatch(/X-Correlation-Id wajib untuk invoice-posted/);
    expect(src).toMatch(/ReceiveInvoicePosted/);
    expect(src).toMatch(/correlationId/);
    expect(src).toMatch(/apId:/);
  });

  it('createHutangFromVendorInvoice accepts correlationId option', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/hutang-from-vendor.ts'), 'utf8');
    expect(src).toMatch(/correlationId\?:/);
    expect(src).toMatch(/correlationId: opts\.correlationId/);
  });

  it('webhook inbox passes payload correlationId to hutang create', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/webhook-inbox-process.ts'), 'utf8');
    expect(src).toMatch(/createdVia: 'invoice-posted-webhook'/);
    expect(src).toMatch(/correlationId: payload\.correlationId/);
  });

  it('indexes include hutang correlation + command ap/invoice', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/operational-indexes.ts'), 'utf8');
    expect(src).toMatch(/idx_hutang_correlation/);
    expect(src).toMatch(/idx_integration_commands_ap/);
    expect(src).toMatch(/idx_integration_commands_invoice/);
  });
});
