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

  it('caps sales job poll under 60s so workers do not block indefinitely', () => {
    expect(src).toMatch(/maxWaitMs\s*=\s*25_000/);
    expect(src).not.toMatch(/maxWaitMs\s*=\s*60_000/);
  });
});
