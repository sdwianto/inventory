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
  const streamSupported = typeof EventSource !== 'undefined';

  // Reset saat jobId berganti — pola "adjust state during render" (bukan di effect).
  const [lastJobId, setLastJobId] = useState(jobId);
  if (lastJobId !== jobId) {
    setLastJobId(jobId);
    setData(null);
    setStreamFailed(false);
    setDone(false);
  }

  useEffect(() => {
    if (!jobId || typeof EventSource === 'undefined') return undefined;

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

  const failed = streamFailed || !streamSupported;
  return { data, streamFailed: failed, done, streaming: !!jobId && !failed && !done };
}

export function useBgJob(jobId: string | null | undefined) {
  const stream = useBgJobStream(jobId);
  const poll = useQuery({
    queryKey: [...BG_JOB_QUERY_KEY, jobId],
    queryFn: () => fetchJson<JsonObject>(`/api/bg-jobs/${jobId}`, { credentials: 'include' }),
    enabled: !!jobId,
    retry: false,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const status = String((stream.data ?? query.state.data)?.status || '');
      if (TERMINAL.has(status)) return false;
      if (!status || status === 'PENDING' || status === 'RUNNING') return 1000;
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
