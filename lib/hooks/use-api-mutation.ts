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

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const KEY_REUSE_WINDOW_MS = 10_000;
const recentKeys = new Map<string, { key: string; at: number }>();

/**
 * Idempotency-Key untuk mutasi online: request identik (url+method+body)
 * dalam jendela singkat memakai key sama — double-click submit = 1 dokumen
 * di server. Setelah jendela lewat, duplikasi disengaja tetap bisa.
 */
export function idempotencyKeyFor(url: string, method: string, body: string | undefined): string {
  const sig = `${method}:${url}:${body ?? ''}`;
  const nowMs = Date.now();
  const hit = recentKeys.get(sig);
  if (hit && nowMs - hit.at < KEY_REUSE_WINDOW_MS) return hit.key;
  const key = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${nowMs}-${Math.random().toString(36).slice(2)}`;
  recentKeys.set(sig, { key, at: nowMs });
  if (recentKeys.size > 200) {
    for (const [k, v] of recentKeys) {
      if (nowMs - v.at > KEY_REUSE_WINDOW_MS) recentKeys.delete(k);
    }
  }
  return key;
}

/** Header Idempotency-Key untuk raw fetch mutations (ModeProduksi / HSL / distribusi). */
export function mutationIdempotencyHeaders(
  url: string,
  method: string,
  body?: string,
): Record<string, string> {
  if (!MUTATION_METHODS.has(method)) return {};
  return { 'Idempotency-Key': idempotencyKeyFor(url, method, body) };
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
      if (MUTATION_METHODS.has(method) && !(headers && ('Idempotency-Key' in headers))) {
        (init.headers as Record<string, string>)['Idempotency-Key'] = idempotencyKeyFor(
          url,
          method,
          typeof init.body === 'string' ? init.body : undefined,
        );
      }
      const res = await fetchOrQueue(url, init);
      return parseMutationResponse<TResult>(res);
    },
    onSuccess: () => {
      for (const key of invalidateKeys) {
        void queryClient.invalidateQueries({ queryKey: key, refetchType: 'active' });
      }
    },
  });
}
