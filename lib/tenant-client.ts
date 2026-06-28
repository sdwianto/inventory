'use client';

import { useEffect, useState } from 'react';
import { getUser } from './auth-client';
import type { TenantSettings } from '@/types/tenant';

export type TenantSettingsCache = TenantSettings & {
  tenantId: string;
  tenantName?: string;
};

let _cache: TenantSettingsCache | null = null;
let _cachePromise: Promise<TenantSettingsCache | null> | null = null;

interface FetchTenantOptions {
  bustCache?: boolean;
}

export const fetchTenantSettings = async (
  tenantId?: string | null,
  { bustCache = false }: FetchTenantOptions = {},
): Promise<TenantSettingsCache | null> => {
  const tid = tenantId || getUser()?.tenantId || 'default';
  if (!bustCache && _cache && _cache.tenantId === tid) return _cache;
  if (_cachePromise && !bustCache) return _cachePromise;

  const user = getUser();
  const params = new URLSearchParams();
  if (user?.role === 'MASTER' && tid) params.set('tenantId', tid);
  if (bustCache) params.set('_t', String(Date.now()));
  const qs = params.toString();

  _cachePromise = fetch(`/api/tenant/settings${qs ? `?${qs}` : ''}`)
    .then((r) => r.json())
    .then((d: TenantSettings) => {
      _cache = { ...d, tenantId: d.tenantId || tid };
      _cachePromise = null;
      return _cache;
    })
    .catch(() => {
      _cachePromise = null;
      return null;
    });
  return _cachePromise;
};

export const invalidateTenantCache = (): void => {
  _cache = null;
  _cachePromise = null;
};

export function useTenantSettings(tenantId?: string | null): TenantSettingsCache | null {
  const tid = tenantId || getUser()?.tenantId || 'default';
  const [settings, setSettings] = useState<TenantSettingsCache | null>(
    _cache?.tenantId === tid ? _cache : null,
  );
  useEffect(() => {
    fetchTenantSettings(tid).then(setSettings);
  }, [tid]);
  return settings;
}
