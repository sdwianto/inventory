import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, _resetRateLimitStoreForTests } from '@/lib/api/rate-limit';

describe('checkRateLimit', () => {
  beforeEach(() => {
    _resetRateLimitStoreForTests();
  });

  it('allows requests under the limit', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(checkRateLimit('test-key', 5, 60_000).allowed).toBe(true);
    }
  });

  it('blocks when limit exceeded', () => {
    for (let i = 0; i < 3; i += 1) {
      checkRateLimit('block-key', 3, 60_000);
    }
    const blocked = checkRateLimit('block-key', 3, 60_000);
    expect(blocked.allowed).toBe(false);
  });
});
