'use client';

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { JsonObject } from '@/types/json';
import { queryKeys } from '@/lib/query-keys';
import { NAV_BADGES_QUERY_KEY } from '@/lib/hooks/use-nav-badges';

/** @deprecated gunakan queryKeys.maintenance.assets.all */
export const ASSETS_QUERY_KEY = queryKeys.maintenance.assets.all;
/** @deprecated */
export const MAINTENANCE_REQUESTS_QUERY_KEY = queryKeys.maintenance.requests.all;
/** @deprecated */
export const MAINTENANCE_SCHEDULES_QUERY_KEY = queryKeys.maintenance.schedules.all;
/** @deprecated */
export const MAINTENANCE_REPORTS_QUERY_KEY = queryKeys.maintenance.reports.all;

export function useAssets(params: { q?: string; status?: string; enabled?: boolean } = {}) {
  const { q = '', status = '', enabled = true } = params;
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (status) qs.set('status', status);
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: queryKeys.maintenance.assets.list({ q, status }),
    queryFn: () => fetchJson<JsonObject[]>(`/api/assets${suffix}`),
    select: (data) => (Array.isArray(data) ? data : []),
    enabled,
    staleTime: 60_000,
  });
}

export function useMaintenanceReport(params: { from?: string; to?: string; assetId?: string; enabled?: boolean } = {}) {
  const { from = '', to = '', assetId = '', enabled = true } = params;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (assetId) qs.set('assetId', assetId);
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: queryKeys.maintenance.reports.report({ from, to, assetId }),
    queryFn: () => fetchJson<JsonObject>(`/api/maintenance-reports${suffix}`),
    enabled,
    staleTime: 60_000,
  });
}

export async function fetchAssetDetail(queryClient: QueryClient, id: string): Promise<JsonObject> {
  return queryClient.fetchQuery({
    queryKey: queryKeys.maintenance.assets.detail(id),
    queryFn: () => fetchJson<JsonObject>(`/api/assets/${id}`),
    staleTime: 60_000,
  });
}

export async function fetchMaintenanceRequestDetail(
  queryClient: QueryClient,
  id: string,
): Promise<JsonObject> {
  return queryClient.fetchQuery({
    queryKey: queryKeys.maintenance.requests.detail(id),
    queryFn: () => fetchJson<JsonObject>(`/api/maintenance-requests/${id}`),
    staleTime: 60_000,
  });
}

export function useInvalidateMaintenance() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.maintenance.assets.all });
    qc.invalidateQueries({ queryKey: queryKeys.maintenance.requests.all });
    qc.invalidateQueries({ queryKey: queryKeys.maintenance.schedules.all });
    qc.invalidateQueries({ queryKey: queryKeys.maintenance.reports.all });
    qc.invalidateQueries({ queryKey: queryKeys.maintenance.serviceOrders.all });
    qc.invalidateQueries({ queryKey: NAV_BADGES_QUERY_KEY });
    window.dispatchEvent(new CustomEvent('erp-maintenance-change'));
  };
}
