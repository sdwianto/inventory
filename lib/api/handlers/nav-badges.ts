/** Badge sidebar — satu request menggantikan 4 polling terpisah. */

import type { NextResponse } from 'next/server';
import { ok } from '@/lib/api/db';
import { resolveOperationalScope, withTenantFilter } from '@/lib/api/tenant-master';
import { countScheduleDueStats, startOfDay } from '@/lib/api/maintenance-schedule-engine';
import { hutangPendingReviewFilter } from '@/lib/api/hutang-filters';
import { MAINTENANCE_REQUESTS_COLLECTION } from '@/lib/maintenance/constants';
import { grnPendingRejectFilter } from '@/lib/api/grn-reject-status';
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

  const [grnPending, grnRejectedPending, hutangReview, wrPending, pmStats, rtvNeedsAttention] = await Promise.all([
    db.collection('goods_receipts').countDocuments(
      withTenantFilter(scopeAuth, {
        status: { $in: ['DRAFT', 'UNKNOWN_PRODUCT', 'NEEDS_MAPPING'] },
      }),
    ),
    db.collection('goods_receipts').countDocuments(
      withTenantFilter(scopeAuth, {
        status: 'POSTED',
        ...grnPendingRejectFilter(),
      }),
    ),
    db.collection('hutang').countDocuments(
      withTenantFilter(scopeAuth, hutangPendingReviewFilter()),
    ),
    db.collection(MAINTENANCE_REQUESTS_COLLECTION).countDocuments(
      withTenantFilter(scopeAuth, { status: 'PENDING_APPROVAL' }),
    ),
    countScheduleDueStats(db, tenantFilter, today),
    // ADR-006 — retur vendor yang butuh tindak lanjut: ditolak vendor (sebagian/semua),
    // masih menunggu vendor tapi sudah lewat tenggat keputusan, atau sync CN ke sales
    // gagal total (stok sudah keluar tapi TIDAK ADA CN sama sekali — bukan "menunggu
    // vendor", tapi retur yang stuck murni butuh retry/tindak lanjut buyer sendiri).
    db.collection('vendor_returns').countDocuments(
      withTenantFilter(scopeAuth, {
        $or: [
          // Menunggu approval internal (SoD) sebelum stok keluar.
          { status: 'PENDING_APPROVAL' },
          // Ditolak (semua/sebagian) — selalu butuh tindak lanjut, terlepas tenggat.
          { vendorDecision: { $in: ['REJECTED', 'PARTIAL'] } },
          // Masih menunggu vendor tapi sudah lewat tenggat 7 hari.
          { vendorDecision: 'PENDING', vendorDecisionDueAt: { $lt: new Date() } },
          // Sync CN gagal — tidak pernah ada CN, tidak ada yang "menunggu vendor".
          { status: 'POSTED', cnSyncStatus: 'FAILED' },
        ],
      }),
    ),
  ]);

  return ok({
    grnPending,
    grnRejectedPending,
    hutangReview,
    wrPending,
    pmOverdue: Number(pmStats?.overdue || 0),
    pmDueSoon: Number(pmStats?.dueSoon || 0),
    rtvNeedsAttention,
  });
}
