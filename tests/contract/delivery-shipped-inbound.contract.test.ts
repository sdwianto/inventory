/**
 * W1-7 / Contract Spec P2: Inventory inbound delivery-shipped (CreateGRN).
 * Companion to Sales tests/contract/delivery-shipped.contract.test.ts (outbound SDK).
 * @see sales/docs/architecture/INTEGRATION-CONTRACT-SPEC.md
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('contract inbound: delivery-shipped (CreateGRN)', () => {
  const src = readFileSync(
    join(process.cwd(), 'lib/api/handlers/integration-inbound.ts'),
    'utf8',
  );

  it('route + Category A header gate', () => {
    expect(src).toContain("/integrations/delivery-shipped");
    expect(src).toContain('Idempotency-Key dan X-Correlation-Id wajib untuk Category A (delivery-shipped)');
    expect(src).toMatch(/idempotency-key/);
    expect(src).toMatch(/x-correlation-id/);
  });

  it('creates GRN via createGrnFromDelivery with correlationId', () => {
    expect(src).toContain('createGrnFromDelivery');
    expect(src).toMatch(/correlationId/);
  });

  it('returns Contract Spec minimum response fields', () => {
    expect(src).toMatch(/grnId:\s*grn\.id/);
    expect(src).toMatch(/noGRN:\s*grn\.noGRN/);
    expect(src).toMatch(/status:\s*grn\.status/);
    expect(src).toMatch(/created/);
    expect(src).toMatch(/existing/);
    expect(src).toMatch(/deliveryId:\s*payload\.deliveryId/);
    expect(src).toMatch(/customerTenantId/);
    expect(src).toMatch(/vendorTenantId/);
    expect(src).toMatch(/correlationId/);
    expect(src).toMatch(/idempotencyKey:\s*idemKey/);
  });
});
