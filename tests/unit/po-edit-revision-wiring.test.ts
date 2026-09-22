import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('customer-po editRevision idempotency', () => {
  it('CreateSO idempotency key includes editRevision when > 0', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/api/customer-po-push.ts'), 'utf8');
    expect(src).toContain('editRevision');
    expect(src).toContain('cpo-push:');
    expect(src).toMatch(/r\$\{rev\}|`\$\{base\}:r\$\{rev\}`/);
  });

  it('cancel SO idempotency supports editRevision', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/api/customer-po-cancel-sales.ts'), 'utf8');
    expect(src).toContain('editRevision');
    expect(src).toContain('cpo-cancel:');
  });

  it('PUT handler requires editReason for post-approve and calls cancel-then-resync', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/api/handlers/customer-po.ts'), 'utf8');
    const putStart = src.indexOf('// PUT /customer-purchase-orders/:id');
    expect(putStart).toBeGreaterThan(-1);
    const putEnd = src.indexOf('// DELETE /customer-purchase-orders/:id', putStart);
    const putBlock = src.slice(putStart, putEnd > putStart ? putEnd : putStart + 8000);
    expect(putBlock).toContain('isPostApprovedPoEditStatus');
    expect(putBlock).toContain('editReason');
    expect(putBlock).toContain('cancelVendorSoForPoEdit');
    expect(putBlock).toContain('resyncVendorSoAfterPoEdit');
    expect(putBlock).toContain('CUSTOMER_PO_EDIT');
    expect(putBlock).toContain('validatePoForApproval');
    expect(putBlock.indexOf('cancelVendorSoForPoEdit')).toBeLessThan(putBlock.indexOf('{ $set: patch }'));
    expect(putBlock.indexOf('{ $set: patch }')).toBeLessThan(putBlock.indexOf('resyncVendorSoAfterPoEdit'));
  });

  it('resync reopens CreateSO outbox and preserves status', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/api/customer-po-edit-resync.ts'), 'utf8');
    expect(src).toContain('reopenEnsureCreateSoOutboxForEdit');
    expect(src).toContain('preserveStatus');
  });

  it('drainCreateSo does not short-circuit DONE without vendor SO', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/api/integration-outbox.ts'), 'utf8');
    expect(src).toContain('reopenEnsureCreateSoOutboxForEdit');
    expect(src).toContain('poHasVendorSoNumbers');
  });
});
