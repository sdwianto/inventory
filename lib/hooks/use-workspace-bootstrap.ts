'use client';

import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import { getActingTenantId } from '@/lib/acting-tenant-client';
import { getUser } from '@/lib/auth-client';
import { setLokasiAktif } from '@/lib/lokasi-client';
import { queryKeys } from '@/lib/query-keys';
import { setClientFeatureFlags } from '@/lib/feature-flags-client';
import type { TenantFeatureFlags } from '@/lib/api/feature-flags';

export interface WorkspaceBootstrap {
  scope: {
    tenantId: string;
    tenantLabel: string;
    lokasiList: Array<Record<string, unknown>>;
    featureFlags?: TenantFeatureFlags;
  };
  branding: {
    tenantId: string;
    companyName: string;
    logoUrl?: string;
    logoBase64?: string;
  };
  tenants: Array<Record<string, unknown>>;
  user: Record<string, unknown> | null;
}

function workspaceUrl(): string | null {
  const user = getUser();
  if (!user) return null;
  const params = new URLSearchParams();
  if (user.role === 'MASTER') {
    const acting = getActingTenantId();
    if (!acting) return null;
    params.set('tenantId', acting);
  }
  const qs = params.toString();
  return `/api/workspace/bootstrap${qs ? `?${qs}` : ''}`;
}

export function useWorkspaceBootstrap(enabled = true) {
  const queryClient = useQueryClient();
  const url = workspaceUrl();
  const key = getActingTenantId() || getUser()?.tenantId || '';

  const query = useQuery({
    queryKey: [...queryKeys.workspace.bootstrap(key)],
    queryFn: () => fetchJson<WorkspaceBootstrap>(url!),
    enabled: enabled && Boolean(url),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspace.bootstrap(key) });
  }, [queryClient, key]);

  useEffect(() => {
    setClientFeatureFlags(query.data?.scope?.featureFlags);
  }, [query.data?.scope?.featureFlags]);

  return {
    ...query,
    scopeId: query.data?.scope?.tenantId || '',
    tenantLabel: query.data?.scope?.tenantLabel || '',
    lokasiList: query.data?.scope?.lokasiList || [],
    branding: query.data?.branding,
    tenants: query.data?.tenants || [],
    invalidate,
  };
}

export function applyWorkspaceLokasi(scopeTenantId: string, lokasiList: Array<Record<string, unknown>>) {
  if (!scopeTenantId || !lokasiList.length) return '';
  const labels = lokasiList.map((l) => {
    const kode = String(l.kode || '');
    const nama = String(l.nama || '');
    return kode && nama ? `${kode} - ${nama}` : kode || nama;
  });
  try {
    const key = `inventory_lokasi_aktif_${scopeTenantId}`;
    const aktif = localStorage.getItem(key) || '';
    if (aktif && labels.includes(aktif)) return aktif;
    if (labels[0]) {
      setLokasiAktif(scopeTenantId, labels[0]);
      return labels[0];
    }
  } catch {
    /* ignore */
  }
  return '';
}
