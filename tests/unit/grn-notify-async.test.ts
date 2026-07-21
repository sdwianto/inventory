import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('grn-notify-sales async contract', () => {
  const src = readFileSync(
    join(process.cwd(), 'lib/api/grn-notify-sales.ts'),
    'utf8',
  );

  it('posts to sales with ?async=1 (not inline)', () => {
    expect(src).toMatch(/grn-posted\?async=1/);
    expect(src).not.toMatch(/grn-posted\?inline=1/);
  });

  it('does not poll sales bg-jobs on HTTP 202 (hutang via webhook)', () => {
    expect(src).not.toMatch(/pollSalesGrnJob/);
    expect(src).not.toMatch(/\/api\/bg-jobs\//);
    expect(src).toMatch(/pending:\s*true/);
    expect(src).toMatch(/salesJobId/);
  });

  it('caps outbound POST timeout under 15s hard', () => {
    expect(src).toMatch(/AbortSignal\.timeout\(12_000\)/);
    expect(src).not.toMatch(/AbortSignal\.timeout\(30_000\)/);
    expect(src).not.toMatch(/AbortSignal\.timeout\(45_000\)/);
  });
});
