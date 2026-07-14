'use client';

import { useState } from 'react';
import { getUser } from '@/lib/auth-client';
import type { SessionUser } from '@/types/auth';

export function useSessionUser(): SessionUser | null {
  const [user] = useState<SessionUser | null>(() => getUser());
  return user;
}

export function useSessionUserWithTenantFilter(defaultTenant = 'default') {
  const [user] = useState<SessionUser | null>(() => getUser());
  const [filterTenantId, setFilterTenantId] = useState(() => {
    const u = getUser();
    return u?.role !== 'MASTER' ? String(u?.tenantId || defaultTenant) : '';
  });

  return { user, filterTenantId, setFilterTenantId };
}
