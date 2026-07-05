import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyDangerousRoute,
  enforceDangerousRouteGuard,
  getDangerousRouteBlockReason,
  requireProductionConfirmPhrase,
  TENANT_PURGE_CONFIRM_PHRASE,
} from '@/lib/api/production-guard';

describe('classifyDangerousRoute', () => {
  it('detects sandbox, seed, and tenant purge', () => {
    expect(classifyDangerousRoute('POST', '/sandbox/reset')).toBe('sandbox');
    expect(classifyDangerousRoute('GET', '/sandbox/worker-preview')).toBeNull();
    expect(classifyDangerousRoute('POST', '/auth/seed')).toBe('auth_seed');
    expect(classifyDangerousRoute('DELETE', '/tenants/acme')).toBe('tenant_purge');
  });
});

describe('production dangerous access', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('blocks non-MASTER in production for sandbox', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOW_SANDBOX_RESET', '1');
    const reason = getDangerousRouteBlockReason('sandbox', {
      userId: 'u1',
      isMaster: false,
      email: 'a@b.com',
      name: 'Admin',
      role: 'ADMIN',
      tenantId: 't1',
      tenantName: 'Tenant',
    });
    expect(reason).toMatch(/MASTER/i);
  });

  it('allows MASTER when env opt-in set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOW_SANDBOX_RESET', '1');
    const reason = getDangerousRouteBlockReason('sandbox', {
      userId: 'u1',
      isMaster: true,
      email: 'm@b.com',
      name: 'Master',
      role: 'MASTER',
      tenantId: 'master',
      tenantName: 'Master',
    });
    expect(reason).toBeNull();
  });

  it('enforceDangerousRouteGuard returns 403 response', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = enforceDangerousRouteGuard('POST', '/auth/seed', {
      userId: 'u1',
      isMaster: false,
      email: 'a@b.com',
      name: 'Admin',
      role: 'ADMIN',
      tenantId: 't1',
      tenantName: 'Tenant',
    });
    expect(res?.status).toBe(403);
  });
});

describe('requireProductionConfirmPhrase', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(requireProductionConfirmPhrase({}, TENANT_PURGE_CONFIRM_PHRASE)).toBeNull();
  });

  it('requires exact phrase in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(requireProductionConfirmPhrase({ confirmPhrase: 'wrong' }, TENANT_PURGE_CONFIRM_PHRASE)).toMatch(/DELETE TENANT/);
    expect(requireProductionConfirmPhrase(
      { confirmPhrase: TENANT_PURGE_CONFIRM_PHRASE },
      TENANT_PURGE_CONFIRM_PHRASE,
    )).toBeNull();
  });

  it('accepts phrase from query string', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const url = new URL('http://localhost/api/tenants/x?confirmPhrase=DELETE%20TENANT');
    expect(requireProductionConfirmPhrase(null, TENANT_PURGE_CONFIRM_PHRASE, url)).toBeNull();
  });
});
