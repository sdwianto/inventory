'use client';

import { useEffect, useState } from 'react';
import { getUser } from '@/lib/auth-client';
import type { SessionUser } from '@/types/auth';

export function useSessionUser(): SessionUser | null {
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    setUser(getUser());
  }, []);

  return user;
}

export function useSessionUserWithTenantFilter(defaultTenant = 'default') {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [filterTenantId, setFilterTenantId] = useState(defaultTenant);

  useEffect(() => {
    const u = getUser();
    setUser(u);
    setFilterTenantId(u?.role !== 'MASTER' ? String(u?.tenantId || defaultTenant) : '');
  }, [defaultTenant]);

  return { user, filterTenantId, setFilterTenantId };
}
