'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { JsonObject } from '@/types/json';

export const BG_JOB_QUERY_KEY = ['bg-job'] as const;

const TERMINAL = new Set(['DONE', 'FAILED']);

function streamUrl(jobId: string) {
  return `/api/bg-jobs/${encodeURIComponent(jobId)}/stream`;
}

function useBgJobStream(jobId: string | null | undefined) {
  const queryClient = useQueryClient();
  const [data, setData] = useState<JsonObject | null>(null);
  const [streamFailed, setStreamFailed] = useState(false);
  const [done, setDone] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!jobId || typeof EventSource === 'undefined') {
      setStreamFailed(true);
      return undefined;
    }

    setData(null);
    setStreamFailed(false);
    setDone(false);

    const es = new EventSource(streamUrl(jobId));
    esRef.current = es;

    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as JsonObject;
        setData(parsed);
        queryClient.setQueryData([...BG_JOB_QUERY_KEY, jobId], parsed);
        const status = String(parsed.status || '');
        if (TERMINAL.has(status)) {
          setDone(true);
          es.close();
        }
      } catch {
        /* ignore malformed chunk */
      }
    };

    es.onerror = () => {
      setStreamFailed(true);
      es.close();
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [jobId, queryClient]);

  return { data, streamFailed, done, streaming: !!jobId && !streamFailed && !done };
}

export function useBgJob(jobId: string | null | undefined) {
  const stream = useBgJobStream(jobId);
  const poll = useQuery({
    queryKey: [...BG_JOB_QUERY_KEY, jobId],
    queryFn: () => fetchJson<JsonObject>(`/api/bg-jobs/${jobId}`),
    enabled: !!jobId && stream.streamFailed,
    refetchInterval: (query) => {
      const status = String(query.state.data?.status || '');
      if (status === 'PENDING' || status === 'RUNNING') return 2000;
      return false;
    },
  });

  const data = stream.data ?? poll.data ?? null;
  const status = String(data?.status || '');

  return {
    data,
    status,
    isLoading: !!jobId && !data && (stream.streaming || poll.isLoading),
    progress: data?.progress ?? null,
    isStreaming: stream.streaming,
  };
}

export function jobProgressMessage(progress: unknown): string | null {
  if (!progress || typeof progress !== 'object') return null;
  const p = progress as Record<string, unknown>;
  if (typeof p.message === 'string' && p.message.trim()) return p.message;
  if (p.page != null) return `Memproses halaman ${p.page}…`;
  return null;
}
