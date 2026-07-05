/** MASTER audit log read + export API (P3 compliance). */

import { NextResponse } from 'next/server';
import type { NextResponse as NextResponseType } from 'next/server';
import type { HandlerContext } from '@/types/api/handler';
import { ok, clean } from '@/lib/api/db';
import { requireRole } from '@/lib/api/require-auth';
import {
  AUDIT_COMPLIANCE_RETENTION_DAYS,
  AUDIT_UI_RETENTION_DAYS,
  auditReadCutoff,
} from '@/lib/api/audit-log';
import { auditRowsToCsv } from '@/lib/api/audit-export';
import { applyDescDateIdCursor, parseCursorPageParams, sliceCursorPage } from '@/lib/api/cursor-page';

function buildAuditFilter(url: URL, scope: 'ui' | 'compliance'): Record<string, unknown> {
  const tenantId = url.searchParams.get('tenantId')?.trim();
  const action = url.searchParams.get('action')?.trim();
  const entityType = url.searchParams.get('entityType')?.trim();
  const entityId = url.searchParams.get('entityId')?.trim();
  const q = url.searchParams.get('q')?.trim();
  const from = url.searchParams.get('from')?.trim();
  const to = url.searchParams.get('to')?.trim();

  let filter: Record<string, unknown> = {
    createdAt: { $gte: auditReadCutoff(scope) },
  };
  if (from) {
    filter.createdAt = {
      ...(typeof filter.createdAt === 'object' ? filter.createdAt as object : {}),
      $gte: new Date(from),
    };
  }
  if (to) {
    const existing = (filter.createdAt && typeof filter.createdAt === 'object')
      ? filter.createdAt as Record<string, unknown>
      : {};
    filter.createdAt = { ...existing, $lte: new Date(`${to}T23:59:59`) };
  }
  if (tenantId) filter.tenantId = tenantId;
  if (action) filter.action = action;
  if (entityType) filter.entityType = entityType;
  if (entityId) filter.entityId = entityId;
  if (q) {
    filter.$or = [
      { summary: { $regex: q, $options: 'i' } },
      { entityId: { $regex: q, $options: 'i' } },
      { userName: { $regex: q, $options: 'i' } },
    ];
  }
  return filter;
}

export async function handleAudit({
  db,
  route,
  method,
  url,
  auth,
}: HandlerContext): Promise<NextResponseType | null> {
  if (route !== '/audit-log' || method !== 'GET') return null;

  const denied = requireRole(auth, ['MASTER']);
  if (denied) return denied;

  const scopeParam = url.searchParams.get('scope');
  const scope: 'ui' | 'compliance' = scopeParam === 'compliance' ? 'compliance' : 'ui';
  const exportFmt = url.searchParams.get('export')?.trim();
  const filter = buildAuditFilter(url, scope);

  if (exportFmt === 'csv') {
    const maxRows = scope === 'compliance' ? 50_000 : 10_000;
    const list = await db.collection('audit_log')
      .find(filter)
      .sort({ createdAt: -1, id: -1 })
      .limit(maxRows)
      .toArray();
    const csv = auditRowsToCsv(list.map((row) => clean(row) as Record<string, unknown>));
    const filename = `audit-log-${scope}-${new Date().toISOString().slice(0, 10)}.csv`;
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const { pageMode, limit, cursor } = parseCursorPageParams(url.searchParams, {
    defaultLimit: 50,
    maxLimit: 200,
  });
  const fetchLimit = pageMode ? limit + 1 : 100;
  const listFilter = pageMode ? applyDescDateIdCursor(filter, cursor, 'createdAt') : filter;

  const list = await db.collection('audit_log')
    .find(listFilter)
    .sort({ createdAt: -1, id: -1 })
    .limit(fetchLimit)
    .toArray();

  const retentionDays = scope === 'compliance'
    ? AUDIT_COMPLIANCE_RETENTION_DAYS
    : AUDIT_UI_RETENTION_DAYS;

  if (pageMode) {
    const { items, hasMore } = sliceCursorPage(list, limit);
    const last = items[items.length - 1] as Record<string, unknown> | undefined;
    return ok({
      items: items.map(clean),
      hasMore,
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify({
          id: String(last.id),
          ts: last.createdAt instanceof Date ? last.createdAt.toISOString() : String(last.createdAt),
        })).toString('base64url')
        : null,
      retentionDays,
      scope,
      complianceRetentionDays: AUDIT_COMPLIANCE_RETENTION_DAYS,
    });
  }

  return ok({
    items: list.map(clean),
    retentionDays,
    scope,
    complianceRetentionDays: AUDIT_COMPLIANCE_RETENTION_DAYS,
  });
}
