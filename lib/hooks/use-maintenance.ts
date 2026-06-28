'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { JsonObject } from '@/types/json';

export const ASSETS_QUERY_KEY = ['assets'];
export const MAINTENANCE_REQUESTS_QUERY_KEY = ['maintenance-requests'];
export const MAINTENANCE_SCHEDULES_QUERY_KEY = ['maintenance-schedules'];
export const MAINTENANCE_REPORTS_QUERY_KEY = ['maintenance-reports'];

export function useAssets(params: { q?: string; status?: string; enabled?: boolean } = {}) {
  const { q = '', status = '', enabled = true } = params;
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (status) qs.set('status', status);
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: [...ASSETS_QUERY_KEY, { q, status }],
    queryFn: () => fetchJson<JsonObject[]>(`/api/assets${suffix}`),
    select: (data) => (Array.isArray(data) ? data : []),
    enabled,
  });
}

export function useMaintenanceRequests(params: { status?: string; enabled?: boolean } = {}) {
  const { status = '', enabled = true } = params;
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return useQuery({
    queryKey: [...MAINTENANCE_REQUESTS_QUERY_KEY, { status }],
    queryFn: () => fetchJson<JsonObject[]>(`/api/maintenance-requests${qs}`),
    select: (data) => (Array.isArray(data) ? data : []),
    enabled,
  });
}

export function useWrPendingCount(enabled = true) {
  return useQuery({
    queryKey: ['maintenance-requests', 'pending-count'],
    queryFn: () => fetchJson<{ count?: number }>('/api/maintenance-requests/pending-count'),
    select: (d) => d?.count ?? 0,
    staleTime: 30_000,
    enabled,
    refetchInterval: enabled ? 60_000 : false,
  });
}

export function usePmDueCount(enabled = true) {
  return useQuery({
    queryKey: ['maintenance-schedules', 'due-count'],
    queryFn: () => fetchJson<{ overdue?: number; dueSoon?: number }>('/api/maintenance-schedules/due-count'),
    select: (d) => d?.overdue ?? 0,
    staleTime: 30_000,
    enabled,
    refetchInterval: enabled ? 60_000 : false,
  });
}

export function useMaintenanceSchedules(params: { status?: string; enabled?: boolean } = {}) {
  const { status = '', enabled = true } = params;
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return useQuery({
    queryKey: [...MAINTENANCE_SCHEDULES_QUERY_KEY, { status }],
    queryFn: () => fetchJson<JsonObject[]>(`/api/maintenance-schedules${qs}`),
    select: (data) => (Array.isArray(data) ? data : []),
    enabled,
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
    queryKey: [...MAINTENANCE_REPORTS_QUERY_KEY, { from, to, assetId }],
    queryFn: () => fetchJson<JsonObject>(`/api/maintenance-reports${suffix}`),
    enabled,
  });
}

export function useInvalidateMaintenance() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ASSETS_QUERY_KEY });
    qc.invalidateQueries({ queryKey: MAINTENANCE_REQUESTS_QUERY_KEY });
    qc.invalidateQueries({ queryKey: MAINTENANCE_SCHEDULES_QUERY_KEY });
    qc.invalidateQueries({ queryKey: MAINTENANCE_REPORTS_QUERY_KEY });
    qc.invalidateQueries({ queryKey: ['maintenance-requests', 'pending-count'] });
    qc.invalidateQueries({ queryKey: ['maintenance-schedules', 'due-count'] });
    window.dispatchEvent(new CustomEvent('erp-maintenance-change'));
  };
}
