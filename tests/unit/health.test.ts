import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildHealthResponse } from '@/lib/api/health';

describe('buildHealthResponse', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports ok when database ping succeeds', async () => {
    const db = {
      command: vi.fn().mockResolvedValue({ ok: 1 }),
      collection: vi.fn().mockReturnValue({
        countDocuments: vi.fn().mockResolvedValue(0),
        findOne: vi.fn().mockResolvedValue(null),
        createIndex: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const health = await buildHealthResponse(db as never, 'inventory');
    expect(health.status).toBe('ok');
    expect(health.checks.database).toBe('ok');
    expect(health.app).toBe('inventory');
    expect(health.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('reports degraded when database ping fails', async () => {
    const db = {
      command: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    const health = await buildHealthResponse(db as never, 'inventory');
    expect(health.status).toBe('degraded');
    expect(health.checks.database).toBe('fail');
    expect(health.checks.databaseError).toMatch(/connection refused/i);
  });

  it('reports degraded when db is null', async () => {
    const health = await buildHealthResponse(null, 'inventory');
    expect(health.status).toBe('degraded');
    expect(health.checks.database).toBe('fail');
  });

  it('includes worker backlog when db is healthy', async () => {
    const db = {
      command: vi.fn().mockResolvedValue({ ok: 1 }),
      collection: vi.fn().mockReturnValue({
        countDocuments: vi.fn().mockResolvedValue(2),
        findOne: vi.fn().mockResolvedValue({ createdAt: new Date(Date.now() - 400_000) }),
        createIndex: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const health = await buildHealthResponse(db as never, 'inventory');
    expect(health.checks.worker?.pendingCount).toBe(2);
    expect(health.checks.worker?.workerStale).toBe(true);
    expect(health.checks.slo?.workerPendingAge?.ok).toBe(false);
    expect(health.status).toBe('degraded');
  });

  it('reports degraded when replica set check fails in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const db = {
      command: vi.fn().mockResolvedValue({ ok: 1 }),
      admin: () => ({
        command: vi.fn().mockResolvedValue({ setName: '' }),
      }),
      collection: vi.fn().mockReturnValue({
        countDocuments: vi.fn().mockResolvedValue(0),
        findOne: vi.fn().mockResolvedValue(null),
        createIndex: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const health = await buildHealthResponse(db as never, 'inventory');
    expect(health.checks.transactions).toBe('fail');
    expect(health.status).toBe('degraded');
  });

  it('includes rateLimit mode in checks', async () => {
    const db = {
      command: vi.fn().mockResolvedValue({ ok: 1 }),
      collection: vi.fn().mockReturnValue({
        countDocuments: vi.fn().mockResolvedValue(0),
        findOne: vi.fn().mockResolvedValue(null),
        createIndex: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const health = await buildHealthResponse(db as never, 'inventory');
    expect(health.checks.rateLimit).toMatch(/redis|memory/);
    expect(health.checks.cache).toMatch(/redis|memory/);
  });

  it('reports degraded when cache required but Redis missing in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const db = {
      command: vi.fn().mockResolvedValue({ ok: 1 }),
      admin: () => ({
        command: vi.fn().mockResolvedValue({ setName: 'rs0' }),
      }),
      collection: vi.fn().mockReturnValue({
        countDocuments: vi.fn().mockResolvedValue(0),
        findOne: vi.fn().mockResolvedValue(null),
        createIndex: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const health = await buildHealthResponse(db as never, 'inventory');
    expect(health.checks.cacheStatus).toBe('fail');
    expect(health.status).toBe('degraded');
  });

  it('includes neverRun integrationReconcile before first cron', async () => {
    const db = {
      command: vi.fn().mockResolvedValue({ ok: 1 }),
      admin: () => ({
        command: vi.fn().mockResolvedValue({ setName: 'rs0' }),
      }),
      collection: vi.fn().mockImplementation((name: string) => {
        if (name === 'bg_jobs') {
          return {
            countDocuments: vi.fn().mockResolvedValue(0),
            findOne: vi.fn().mockResolvedValue(null),
            createIndex: vi.fn().mockResolvedValue(undefined),
          };
        }
        if (name === 'integration_reconcile_reports') {
          return {
            find: () => ({
              sort: () => ({
                limit: () => ({
                  project: () => ({ toArray: async () => [] }),
                }),
              }),
            }),
          };
        }
        return { countDocuments: vi.fn().mockResolvedValue(0) };
      }),
    };
    const health = await buildHealthResponse(db as never, 'inventory');
    expect(health.checks.integrationReconcile?.neverRun).toBe(true);
    expect(health.checks.integrationReconcile?.message).toMatch(/belum pernah/i);
  });

  it('reports degraded when integration reconcile finds mismatches', async () => {
    const db = {
      command: vi.fn().mockResolvedValue({ ok: 1 }),
      admin: () => ({
        command: vi.fn().mockResolvedValue({ setName: 'rs0' }),
      }),
      collection: vi.fn().mockImplementation((name: string) => {
        if (name === 'bg_jobs') {
          return {
            countDocuments: vi.fn().mockResolvedValue(0),
            findOne: vi.fn().mockResolvedValue(null),
            createIndex: vi.fn().mockResolvedValue(undefined),
          };
        }
        if (name === 'integration_reconcile_reports') {
          return {
            find: () => ({
              sort: () => ({
                limit: () => ({
                  project: () => ({
                    toArray: async () => [{
                      summary: { totalMismatch: 4 },
                      createdAt: new Date(),
                    }],
                  }),
                }),
              }),
            }),
          };
        }
        return { countDocuments: vi.fn().mockResolvedValue(0) };
      }),
    };
    const health = await buildHealthResponse(db as never, 'inventory');
    expect(health.checks.integrationReconcile?.totalMismatch).toBe(4);
    expect(health.status).toBe('degraded');
  });

  it('reports degraded in production when reconcile never ran', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const db = {
      command: vi.fn().mockResolvedValue({ ok: 1 }),
      admin: () => ({
        command: vi.fn().mockResolvedValue({ setName: 'rs0' }),
      }),
      collection: vi.fn().mockImplementation((name: string) => {
        if (name === 'bg_jobs') {
          return {
            countDocuments: vi.fn().mockResolvedValue(0),
            findOne: vi.fn().mockResolvedValue(null),
            createIndex: vi.fn().mockResolvedValue(undefined),
          };
        }
        if (name === 'integration_reconcile_reports') {
          return {
            find: () => ({
              sort: () => ({
                limit: () => ({
                  project: () => ({ toArray: async () => [] }),
                }),
              }),
            }),
          };
        }
        return { countDocuments: vi.fn().mockResolvedValue(0) };
      }),
    };
    const health = await buildHealthResponse(db as never, 'inventory');
    expect(health.checks.integrationReconcile?.neverRun).toBe(true);
    expect(health.status).toBe('degraded');
  });
});
