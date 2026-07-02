'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { JsonObject } from '@/types/json';

export const BG_JOB_QUERY_KEY = ['bg-job'] as const;

export function useBgJob(jobId: string | null | undefined) {
  return useQuery({
    queryKey: [...BG_JOB_QUERY_KEY, jobId],
    queryFn: () => fetchJson<JsonObject>(`/api/bg-jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const status = String(query.state.data?.status || '');
      if (status === 'PENDING' || status === 'RUNNING') return 2000;
      return false;
    },
  });
}
