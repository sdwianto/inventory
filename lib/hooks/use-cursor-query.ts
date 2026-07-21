'use client';

import { useCallback } from 'react';
import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';

export interface CursorPage<T> {
  items?: T[];
  nextCursor?: string | null;
  hasMore?: boolean;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

function buildUrl(base: string, limit: number, cursor: string | null) {
  const sep = base.includes('?') ? '&' : '?';
  let url = `${base}${sep}pageMode=cursor&limit=${limit}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  return url;
}

type RefetchIntervalOption =
  | number
  | false
  | ((query: { state: { data?: { pages?: CursorPage<unknown>[] } } }) => number | false | undefined);

export function useCursorQuery<T>(
  queryKey: QueryKey,
  baseUrl: string | null | undefined,
  {
    limit = 100,
    enabled = true,
    refetchInterval,
    staleTime = 60_000,
  }: {
    limit?: number;
    enabled?: boolean;
    refetchInterval?: RefetchIntervalOption;
    staleTime?: number;
  } = {},
) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      fetchJson<CursorPage<T>>(
        buildUrl(baseUrl!, limit, (pageParam as string | null) ?? null),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage?.hasMore && lastPage?.nextCursor ? lastPage.nextCursor : undefined,
    enabled: Boolean(baseUrl) && enabled,
    staleTime,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RQ menerima number | false | (query) => …
    refetchInterval: refetchInterval as any,
    refetchOnWindowFocus: true,
  });

  const items = (query.data?.pages ?? []).flatMap((p) => p.items ?? []);

  const reload = useCallback(async (_opts?: { silent?: boolean }) => {
    await query.refetch();
  }, [query]);

  const loadMore = useCallback(async () => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      await query.fetchNextPage();
    }
  }, [query]);

  return {
    items,
    loading: query.isLoading,
    loadingMore: query.isFetchingNextPage,
    hasMore: Boolean(query.hasNextPage),
    error: query.error?.message ?? null,
    reload,
    loadMore,
    query,
  };
}
