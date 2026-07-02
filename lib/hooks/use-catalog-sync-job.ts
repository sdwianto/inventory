'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { JsonObject } from '@/types/json';
import { BG_JOB_QUERY_KEY, jobProgressMessage } from '@/lib/hooks/use-bg-job';

export const CATALOG_JOB_QUERY_KEY = ['integrations', 'catalog-job'] as const;

const TERMINAL = new Set(['DONE', 'FAILED']);

function streamUrl(jobId: string) {
  return `/api/integrations/jobs/${encodeURIComponent(jobId)}/stream`;
}

function useCatalogJobStream(jobId: string | null | undefined) {
  const queryClient = useQueryClient();
  const [data, setData] = useState<JsonObject | null>(null);
  const [streamFailed, setStreamFailed] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!jobId || typeof EventSource === 'undefined') {
      setStreamFailed(true);
      return undefined;
    }

    setData(null);
    setStreamFailed(false);
    setDone(false);

    const es = new EventSource(streamUrl(jobId));

    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as JsonObject;
        setData(parsed);
        queryClient.setQueryData([...CATALOG_JOB_QUERY_KEY, jobId], parsed);
        queryClient.setQueryData([...BG_JOB_QUERY_KEY, jobId], parsed);
        const status = String(parsed.status || '');
        if (TERMINAL.has(status)) {
          setDone(true);
          es.close();
        }
      } catch {
        /* ignore */
      }
    };

    es.onerror = () => {
      setStreamFailed(true);
      es.close();
    };

    return () => es.close();
  }, [jobId, queryClient]);

  return { data, streamFailed, done, streaming: !!jobId && !streamFailed && !done };
}

export function useCatalogSyncJob(jobId: string | null | undefined) {
  const stream = useCatalogJobStream(jobId);
  const poll = useQuery({
    queryKey: [...CATALOG_JOB_QUERY_KEY, jobId],
    queryFn: () => fetchJson<JsonObject>(`/api/integrations/jobs/${jobId}`),
    enabled: !!jobId && stream.streamFailed,
    refetchInterval: (query) => {
      const status = String(query.state.data?.status || '');
      if (status === 'PENDING' || status === 'RUNNING') return 2000;
      return false;
    },
  });

  const data = stream.data ?? poll.data ?? null;

  return {
    data,
    status: String(data?.status || ''),
    progress: data?.progress ?? null,
    progressMessage: jobProgressMessage(data?.progress),
    isStreaming: stream.streaming,
  };
}
