'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchJson } from '@/lib/fetch-json';
import { buildCursorListUrl, takeCursorPrefetch } from '@/lib/cursor-prefetch-cache';

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

interface CursorPageResponse<T> {
  items?: T[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

function buildUrl(base: string, limit: number, cursor: string | null) {
  return buildCursorListUrl(base, limit, cursor);
}

export function useCursorList<T>(
  baseUrl: string,
  { limit = 100, enabled = true }: { limit?: number; enabled?: boolean } = {},
): CursorListState<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPage = useCallback((page: CursorPageResponse<T> | T[], append: boolean) => {
    if (Array.isArray(page)) {
      setItems(page);
      setNextCursor(null);
      setHasMore(false);
      return;
    }
    const rows = page.items || [];
    setItems((prev) => (append ? [...prev, ...rows] : rows));
    setNextCursor(page.nextCursor || null);
    setHasMore(Boolean(page.hasMore));
  }, []);

  const reload = useCallback(async (opts?: { silent?: boolean }) => {
    if (!enabled) return;
    const silent = opts?.silent && items.length > 0;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const prefetched = !silent ? takeCursorPrefetch(baseUrl, limit) : null;
      const data = prefetched ?? await fetchJson<CursorPageResponse<T> | T[]>(buildUrl(baseUrl, limit, null));
      applyPage(data, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [applyPage, baseUrl, enabled, items.length, limit]);

  const loadMore = useCallback(async () => {
    if (!enabled || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const data = await fetchJson<CursorPageResponse<T>>(buildUrl(baseUrl, limit, nextCursor));
      applyPage(data, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [applyPage, baseUrl, enabled, limit, loadingMore, nextCursor]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, loadingMore, hasMore, nextCursor, error, reload, loadMore };
}
