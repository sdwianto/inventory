import { describe, it, expect, vi, afterEach } from 'vitest';
import { isSentryEnabled } from '@/lib/api/sentry';

describe('sentry (P1.1a)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('disabled without DSN', () => {
    vi.stubEnv('SENTRY_DSN', '');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '');
    expect(isSentryEnabled()).toBe(false);
  });

  it('enabled with SENTRY_DSN', () => {
    vi.stubEnv('SENTRY_DSN', 'https://key@o123.ingest.sentry.io/456');
    expect(isSentryEnabled()).toBe(true);
  });
});
