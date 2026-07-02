/** In-memory cache halaman pertama cursor list — dipakai prefetch menu hover. */

import { fetchJson } from '@/lib/fetch-json';

const STALE_MS = 60_000;

interface CacheEntry {
  data: unknown;
  ts: number;
}

const cache = new Map<string, CacheEntry>();

export function buildCursorListUrl(base: string, limit: number, cursor: string | null = null): string {
  const sep = base.includes('?') ? '&' : '?';
  let url = `${base}${sep}pageMode=cursor&limit=${limit}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  return url;
}

function normalizeBaseKey(base: string): string {
  const path = base.startsWith('/') ? base : `/${base}`;
  const qIdx = path.indexOf('?');
  const pathname = qIdx >= 0 ? path.slice(0, qIdx) : path;
  const params = new URLSearchParams(qIdx >= 0 ? path.slice(qIdx + 1) : '');
  params.delete('pageMode');
  params.delete('cursor');
  params.delete('limit');
  if (params.get('q') === '') params.delete('q');
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const qs = new URLSearchParams(sorted).toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function cacheKey(base: string, limit: number): string {
  return `${normalizeBaseKey(base)}::${limit}`;
}

export function setCursorPrefetch(base: string, limit: number, data: unknown): void {
  cache.set(cacheKey(base, limit), { data, ts: Date.now() });
}

export function takeCursorPrefetch(base: string, limit: number): unknown | null {
  const key = cacheKey(base, limit);
  const entry = cache.get(key);
  if (!entry) return null;
  cache.delete(key);
  if (Date.now() - entry.ts > STALE_MS) return null;
  return entry.data;
}

/** Prefetch halaman pertama ke cache modul (bukan React Query). */
export async function prefetchCursorList(base: string, limit = 100): Promise<void> {
  try {
    const data = await fetchJson(buildCursorListUrl(base, limit, null));
    setCursorPrefetch(base, limit, data);
  } catch {
    // prefetch best-effort — abaikan error
  }
}
