import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('postVendorReturn', () => {
  it('klaim POSTING di-revert pada fallback non-TX jika stok gagal', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/vendor-return-post.ts'), 'utf8');
    expect(src).toMatch(/priorStatus/);
    expect(src).toMatch(/if \(!session\)/);
    expect(src).toMatch(/status: priorStatus/);
    expect(src).toMatch(/postingStartedAt: null/);
    expect(src).toMatch(/if \(stock\.error\) throw/);
  });
});
