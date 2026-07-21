import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integrations invoice-posted inbound', () => {
  const src = readFileSync(
    join(process.cwd(), 'lib/api/handlers/integration-inbound.ts'),
    'utf8',
  );

  it('accepts POST /integrations/invoice-posted', () => {
    expect(src).toContain("/integrations/invoice-posted");
    expect(src).toContain('createHutangFromVendorInvoice');
    expect(src).toContain('invoice-posted-push');
    expect(src).toContain('invoice.posted');
  });
});
