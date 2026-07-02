/** Badge sidebar — satu request menggantikan 4 polling terpisah. */

import type { NextResponse } from 'next/server';
import { ok } from '@/lib/api/db';
import { resolveOperationalScope, withTenantFilter } from '@/lib/api/tenant-master';
import { countScheduleDueStats, startOfDay } from '@/lib/api/maintenance-schedule-engine';
import { hutangPendingReviewFilter } from '@/lib/api/hutang-filters';
import { MAINTENANCE_REQUESTS_COLLECTION } from '@/lib/maintenance/constants';
import type { HandlerContext } from '@/types/api/handler';

export async function handleNavBadges({
  db,
  route,
  method,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (route !== '/nav-badges' || method !== 'GET') return null;

  const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
  if (denied) return denied;

  const today = startOfDay(new Date());
  const tenantFilter = withTenantFilter(scopeAuth, {});

  const [grnPending, hutangReview, wrPending, pmStats] = await Promise.all([
    db.collection('goods_receipts').countDocuments(
      withTenantFilter(scopeAuth, {
        status: { $in: ['DRAFT', 'UNKNOWN_PRODUCT', 'NEEDS_MAPPING'] },
      }),
    ),
    db.collection('hutang').countDocuments(
      withTenantFilter(scopeAuth, hutangPendingReviewFilter()),
    ),
    db.collection(MAINTENANCE_REQUESTS_COLLECTION).countDocuments(
      withTenantFilter(scopeAuth, { status: 'PENDING_APPROVAL' }),
    ),
    countScheduleDueStats(db, tenantFilter, today),
  ]);

  return ok({
    grnPending,
    hutangReview,
    wrPending,
    pmOverdue: Number(pmStats?.overdue || 0),
    pmDueSoon: Number(pmStats?.dueSoon || 0),
  });
}
