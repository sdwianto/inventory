import { describe, expect, it } from 'vitest';
import {
  normalizeTenantId,
  tenantIdMatchFilter,
  tenantFilterForQuery,
  canAccessTenantDoc,
  mergeTenantScopeFromAuth,
} from '@/lib/api/tenant-scope';
import type { AuthContext } from '@/types/auth';

describe('tenant-scope', () => {
  it('normalizeTenantId lowercases and handles empty', () => {
    expect(normalizeTenantId('SPPG')).toBe('sppg');
    expect(normalizeTenantId('')).toBe('default');
    expect(normalizeTenantId(null)).toBe('default');
  });

  it('tenantIdMatchFilter matches legacy default tenant docs', () => {
    const f = tenantIdMatchFilter('default');
    expect(f).toHaveProperty('$or');
  });

  it('tenantFilterForQuery allows MASTER all tenants', () => {
    expect(tenantFilterForQuery('sppg', 'MASTER')).toEqual({});
  });

  it('tenantFilterForQuery scopes non-master', () => {
    const f = tenantFilterForQuery('sppg', 'ADMIN');
    expect(f).toHaveProperty('tenantId');
  });

  it('canAccessTenantDoc enforces tenant boundary', () => {
    expect(canAccessTenantDoc({ tenantId: 'sppg' }, 'sppg', 'ADMIN')).toBe(true);
    expect(canAccessTenantDoc({ tenantId: 'sppg' }, 'other', 'ADMIN')).toBe(false);
    expect(canAccessTenantDoc({ tenantId: 'sppg' }, 'other', 'MASTER')).toBe(true);
  });

  it('mergeTenantScopeFromAuth combines filters', () => {
    const auth: AuthContext = {
      userId: 'u1',
      email: 'a@b.c',
      name: 'A',
      role: 'ADMIN',
      tenantId: 'sppg',
      tenantName: 'SPPG',
      isMaster: false,
    };
    const merged = mergeTenantScopeFromAuth({ status: 'DRAFT' }, auth);
    expect(merged).toHaveProperty('$and');
  });
});
