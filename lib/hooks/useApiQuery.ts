'use client';

import {
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';

export { useQueryClient };

export function useApiQuery<T>(
  queryKey: QueryKey,
  url: string | null | undefined,
  options?: Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<T, Error>({
    queryKey,
    queryFn: () => fetchJson<T>(url!),
    enabled: Boolean(url) && options?.enabled !== false,
    ...options,
  });
}
