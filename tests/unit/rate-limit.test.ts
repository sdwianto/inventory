import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, _resetRateLimitStoreForTests } from '@/lib/api/rate-limit';

describe('checkRateLimit', () => {
  beforeEach(() => {
    _resetRateLimitStoreForTests();
  });

  it('allows requests under the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await checkRateLimit('test-key', 5, 60_000)).allowed).toBe(true);
    }
  });

  it('blocks when limit exceeded', async () => {
    for (let i = 0; i < 3; i += 1) {
      await checkRateLimit('block-key', 3, 60_000);
    }
    const blocked = await checkRateLimit('block-key', 3, 60_000);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
    }
  });
});
