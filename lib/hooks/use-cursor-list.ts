'use client';

import { useCursorQuery, type CursorPage } from '@/lib/hooks/use-cursor-query';

export interface CursorListState<T> {
  items: T[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  error: string | null;
  reload: (opts?: { silent?: boolean }) => Promise<void>;
  loadMore: () => Promise<void>;
}

/** Wrapper kompatibel — di belakang memakai React Query infinite cache. */
export function useCursorList<T>(
  baseUrl: string,
  {
    limit = 100,
    enabled = true,
    queryKey,
  }: { limit?: number; enabled?: boolean; queryKey?: readonly unknown[] } = {},
): CursorListState<T> {
  const key = queryKey ?? (['cursor-list', baseUrl, limit] as const);
  const {
    items,
    loading,
    loadingMore,
    hasMore,
    error,
    reload,
    loadMore,
    query,
  } = useCursorQuery<T>(key, baseUrl, { limit, enabled });

  const lastPage = query.data?.pages?.[query.data.pages.length - 1] as CursorPage<T> | undefined;

  return {
    items,
    loading,
    loadingMore,
    hasMore,
    nextCursor: lastPage?.nextCursor ?? null,
    error,
    reload,
    loadMore,
  };
}
