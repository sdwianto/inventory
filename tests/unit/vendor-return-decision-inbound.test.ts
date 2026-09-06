import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integrations vendor-return-decision inbound', () => {
  const src = readFileSync(
    join(process.cwd(), 'lib/api/handlers/integration-inbound.ts'),
    'utf8',
  );

  it('accepts POST /integrations/vendor-return-decision', () => {
    expect(src).toContain("/integrations/vendor-return-decision");
    expect(src).toContain('X-Correlation-Id wajib untuk vendor-return-decision');
    expect(src).toContain('applyVendorReturnDecision');
    expect(src).toContain('ReceiveVendorReturnDecision');
  });

  it('parses wire field lineId (bukan invoiceLineId) dari tiap baris lineDecisions', () => {
    const block = src.slice(src.indexOf("/integrations/vendor-return-decision"));
    const endIdx = block.indexOf("\n  }\n\n  return null;");
    const routeBlock = endIdx > -1 ? block.slice(0, endIdx) : block;
    expect(routeBlock).toMatch(/row\.lineId/);
    expect(routeBlock).not.toMatch(/row\.invoiceLineId/);
    expect(routeBlock).toContain('lineDecisions wajib minimal 1 baris');
    expect(routeBlock).toContain('wajib lineId + decision ACCEPTED/REJECTED');
    expect(routeBlock).toMatch(/ditolak wajib alasan/);
  });
});
