/** Cursor pagination — optional via ?pageMode=cursor&limit=&cursor= */

export interface CursorPayload {
  id: string;
  ts?: string;
  str?: string;
}

export interface CursorPageParams {
  pageMode: boolean;
  limit: number;
  cursor: string | null;
}

export function parseCursorPageParams(
  url: URLSearchParams,
  { defaultLimit = 100, maxLimit = 500 }: { defaultLimit?: number; maxLimit?: number } = {},
): CursorPageParams {
  const pageMode = url.get('pageMode') === 'cursor';
  const parsed = parseInt(url.get('limit') || String(defaultLimit), 10);
  const limit = Math.min(Math.max(parsed || defaultLimit, 1), maxLimit);
  const cursor = url.get('cursor');
  return { pageMode, limit, cursor: cursor || null };
}

export function encodeCursor(doc: Record<string, unknown>, sortField = 'tanggal'): string {
  const raw = doc[sortField];
  const ts = raw instanceof Date
    ? raw.toISOString()
    : (raw ? new Date(String(raw)).toISOString() : '');
  const payload: CursorPayload = { id: String(doc.id || ''), ts };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): CursorPayload | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
    if (!parsed?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function applyDescDateIdCursor(
  baseFilter: Record<string, unknown>,
  cursor: string | null | undefined,
  sortField = 'tanggal',
): Record<string, unknown> {
  const decoded = decodeCursor(cursor);
  if (!decoded?.id) return baseFilter;
  const date = decoded.ts ? new Date(decoded.ts) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return { $and: [baseFilter, { id: { $lt: decoded.id } }] };
  }
  return {
    $and: [
      baseFilter,
      {
        $or: [
          { [sortField]: { $lt: date } },
          { [sortField]: date, id: { $lt: decoded.id } },
        ],
      },
    ],
  };
}

export function applyAscDateIdCursor(
  baseFilter: Record<string, unknown>,
  cursor: string | null | undefined,
  sortField = 'nextDueDate',
): Record<string, unknown> {
  const decoded = decodeCursor(cursor);
  if (!decoded?.id) return baseFilter;
  const date = decoded.ts ? new Date(decoded.ts) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return { $and: [baseFilter, { id: { $gt: decoded.id } }] };
  }
  return {
    $and: [
      baseFilter,
      {
        $or: [
          { [sortField]: { $gt: date } },
          { [sortField]: date, id: { $gt: decoded.id } },
        ],
      },
    ],
  };
}

export function encodeStringCursor(doc: Record<string, unknown>, sortField = 'nama'): string {
  const payload: CursorPayload = {
    id: String(doc.id || ''),
    str: String(doc[sortField] ?? ''),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function applyAscStringIdCursor(
  baseFilter: Record<string, unknown>,
  cursor: string | null | undefined,
  sortField = 'nama',
): Record<string, unknown> {
  const decoded = decodeCursor(cursor);
  if (!decoded?.id) return baseFilter;
  const strVal = decoded.str ?? '';
  return {
    $and: [
      baseFilter,
      {
        $or: [
          { [sortField]: { $gt: strVal } },
          { [sortField]: strVal, id: { $gt: decoded.id } },
        ],
      },
    ],
  };
}

export function sliceCursorPage<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

export function cursorPageResponse<T>(
  items: T[],
  limit: number,
  sortField: string,
  lastDoc: Record<string, unknown> | undefined,
) {
  const hasMore = items.length >= limit;
  return {
    items,
    hasMore,
    nextCursor: hasMore && lastDoc ? encodeCursor(lastDoc, sortField) : null,
  };
}
