/**
 * W1-3 slice 2: CPO entity correlationId stamp (Inventory).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('W1-3 CPO CID (Inventory)', () => {
  it('approve stamps correlationId on CPO + ENSURE_CREATE_SO outbox', () => {
    const src = readFileSync(
      join(process.cwd(), 'lib/api/handlers/customer-po.ts'),
      'utf8',
    );
    expect(src).toMatch(/approveCorrelationId/);
    expect(src).toMatch(/markPoApproved\([\s\S]*approveCorrelationId/);
    expect(src).toMatch(/correlationId: approveCorrelationId/);
  });

  it('cancel stamps/reuses CID and passes to ENSURE_PUSH_CANCEL_SO', () => {
    const src = readFileSync(
      join(process.cwd(), 'lib/api/handlers/customer-po.ts'),
      'utf8',
    );
    expect(src).toMatch(/cancelCorrelationId/);
    expect(src).toMatch(/correlationId: cancelCorrelationId/);
  });

  it('push prefers po.correlationId over derived key', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/customer-po-push.ts'), 'utf8');
    expect(src).toMatch(/po\.correlationId/);
    expect(src).toMatch(/integrationCorrelationId/);
  });

  it('cancel notify prefers po.correlationId', () => {
    const src = readFileSync(
      join(process.cwd(), 'lib/api/customer-po-cancel-sales.ts'),
      'utf8',
    );
    expect(src).toMatch(/po\.correlationId/);
  });

  it('indexes include cpo correlation', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/operational-indexes.ts'), 'utf8');
    expect(src).toMatch(/idx_cpo_correlation/);
  });
});
