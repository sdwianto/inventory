'use client';

import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { fetchOrQueue } from '@/lib/offline-mutation-queue';

type MutateInput<TBody> = {
  url: string;
  method?: string;
  body?: TBody;
  headers?: Record<string, string>;
  offlineLabel?: string;
};

async function parseMutationResponse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data && data.error)
      ? String(data.error)
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

/** Mutasi API dengan invalidate cache + dukungan antrian offline. */
export function useApiMutation<TBody = unknown, TResult = unknown>(
  invalidateKeys: QueryKey[] = [],
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, Error, MutateInput<TBody>>({
    mutationFn: async ({ url, method = 'POST', body, headers, offlineLabel }) => {
      const init: RequestInit & { offlineLabel?: string } = {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...headers },
        offlineLabel,
      };
      if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
        init.body = JSON.stringify(body);
      }
      const res = await fetchOrQueue(url, init);
      return parseMutationResponse<TResult>(res);
    },
    onSuccess: async () => {
      for (const key of invalidateKeys) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}
