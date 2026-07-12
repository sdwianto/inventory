import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSandboxResetJob } from '@/lib/api/inventory-execution-handlers';

vi.mock('@/lib/api/sandbox-purge', () => ({
  runSandboxResetJob: vi.fn().mockResolvedValue({ ok: true }),
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL_ENV };
});

describe('executeSandboxResetJob guard (EE-9E)', () => {
  it('blocks purge in production when ALLOW_SANDBOX_RESET is not set', async () => {
    vi.stubEnv('ALLOW_SANDBOX_RESET', '');
    const db = {} as never;
    const result = await executeSandboxResetJob(db, { tenantId: 't1' });
    expect(result).toEqual({
      error: 'Production: set ALLOW_SANDBOX_RESET=1 untuk purge sandbox via worker.',
    });
    const { runSandboxResetJob } = await import('@/lib/api/sandbox-purge');
    expect(runSandboxResetJob).not.toHaveBeenCalled();
  });

  it('allows purge when ALLOW_SANDBOX_RESET=1', async () => {
    vi.stubEnv('ALLOW_SANDBOX_RESET', '1');
    const db = {} as never;
    const result = await executeSandboxResetJob(db, { tenantId: 't1' }, 'job-1');
    expect(result).toEqual({ ok: true });
    const { runSandboxResetJob } = await import('@/lib/api/sandbox-purge');
    expect(runSandboxResetJob).toHaveBeenCalledWith(db, {
      tenantId: 't1',
      includeSales: true,
      preserveJobId: 'job-1',
    });
  });
});
