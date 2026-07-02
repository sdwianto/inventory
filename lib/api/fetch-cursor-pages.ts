/** Ambil semua halaman cursor pagination untuk export / bulk ops. */

import { fetchJson } from '@/lib/fetch-json';

interface CursorPage<T> {
  items?: T[];
  hasMore?: boolean;
  nextCursor?: string | null;
}

function buildUrl(base: string, limit: number, cursor: string | null) {
  const sep = base.includes('?') ? '&' : '?';
  let url = `${base}${sep}pageMode=cursor&limit=${limit}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  return url;
}

export async function fetchAllCursorPages<T>(
  baseUrl: string,
  { limit = 100, maxPages = 200 }: { limit?: number; maxPages?: number } = {},
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  let pages = 0;

  while (hasMore && pages < maxPages) {
    const data = await fetchJson<CursorPage<T> | T[]>(buildUrl(baseUrl, limit, cursor));
    if (Array.isArray(data)) {
      all.push(...data);
      break;
    }
    const rows = data.items || [];
    all.push(...rows);
    hasMore = Boolean(data.hasMore && data.nextCursor);
    cursor = data.nextCursor ? String(data.nextCursor) : null;
    pages += 1;
    if (!rows.length) break;
  }

  return all;
}
