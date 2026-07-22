import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('sales remote purge response parsing', () => {
  beforeEach(() => {
    vi.stubEnv('SALES_APP_URL', 'http://sales:3000');
    vi.stubEnv('WORKER_SECRET', 'test-worker-secret-min-32-chars-xx');
    vi.stubEnv('DEPLOYMENT_MODE', 'vps');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('rejects HTTP 200 without counts (false-success)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: 'ok' }),
    }));

    const { executeSalesSandboxRemote } = await import('@/lib/api/sandbox-purge-sales-remote');
    const remote = await executeSalesSandboxRemote();
    expect(remote?.ok).toBe(false);
    expect(remote && 'error' in remote ? remote.error : '').toMatch(/counts/i);
  });

  it('accepts valid purge payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        label: 'sales',
        dbName: 'kasir_db',
        counts: { sales_orders: { before: 3, deleted: 3 } },
        summary: { documents: 3, collections: 1 },
      }),
    }));

    const { executeSalesSandboxRemote } = await import('@/lib/api/sandbox-purge-sales-remote');
    const remote = await executeSalesSandboxRemote();
    expect(remote?.ok).toBe(true);
    if (remote?.ok) {
      expect(remote.result.dbName).toBe('kasir_db');
      expect(remote.result.counts.sales_orders).toEqual({ before: 3, deleted: 3 });
    }
  });
});
