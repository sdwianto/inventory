'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { JsonObject } from '@/types/json';

export const CATALOG_JOB_QUERY_KEY = ['integrations', 'catalog-job'] as const;

export function useCatalogSyncJob(jobId: string | null | undefined) {
  return useQuery({
    queryKey: [...CATALOG_JOB_QUERY_KEY, jobId],
    queryFn: () => fetchJson<JsonObject>(`/api/integrations/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const status = String(query.state.data?.status || '');
      if (status === 'PENDING' || status === 'RUNNING') return 2000;
      return false;
    },
  });
}
