import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWorkerProcessRoute, isWorkerReconcileRoute, isWorkerRoute, verifyWorkerOrCronSecret } from '@/lib/api/worker-auth';

function req(headers: Record<string, string> = {}): Request {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (k: string) => map.get(k.toLowerCase()) ?? null } } as Request;
}

describe('isWorkerProcessRoute', () => {
  it('matches bg-jobs process GET/POST only', () => {
    expect(isWorkerProcessRoute('GET', '/bg-jobs/process')).toBe(true);
    expect(isWorkerProcessRoute('POST', '/bg-jobs/process')).toBe(true);
    expect(isWorkerProcessRoute('GET', '/bg-jobs/enqueue-integration-reconcile')).toBe(false);
  });
});

describe('isWorkerReconcileRoute', () => {
  it('matches reconcile enqueue GET/POST', () => {
    expect(isWorkerReconcileRoute('GET', '/bg-jobs/enqueue-integration-reconcile')).toBe(true);
    expect(isWorkerReconcileRoute('GET', '/bg-jobs/enqueue-reconcile')).toBe(true);
    expect(isWorkerReconcileRoute('GET', '/bg-jobs/process')).toBe(false);
  });
});

describe('isWorkerRoute', () => {
  it('includes reconcile enqueue for router auth bypass', () => {
    expect(isWorkerRoute('GET', '/bg-jobs/enqueue-integration-reconcile')).toBe(true);
    expect(isWorkerRoute('GET', '/bg-jobs/enqueue-reconcile')).toBe(true);
  });
});

describe('verifyWorkerOrCronSecret', () => {
  const secret = 'b'.repeat(64);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects missing auth', () => {
    vi.stubEnv('WORKER_SECRET', secret);
    expect(verifyWorkerOrCronSecret(undefined)).toBe(false);
    expect(verifyWorkerOrCronSecret(req())).toBe(false);
  });

  it('accepts worker secret via header or bearer', () => {
    vi.stubEnv('WORKER_SECRET', secret);
    vi.stubEnv('CRON_SECRET', '');
    expect(verifyWorkerOrCronSecret(req({ 'X-Worker-Secret': secret }))).toBe(true);
    expect(verifyWorkerOrCronSecret(req({ Authorization: `Bearer ${secret}` }))).toBe(true);
  });
});
