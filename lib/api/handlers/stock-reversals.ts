/** Fase 5c — pembalik stok (RVS) RL / PBL / penyesuaian / transfer: daftar, cek, ajukan, setujui, tolak, batal. */

import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { requireRole, STOCK_REVERSAL_APPROVE_ROLES, STOCK_REVERSAL_REQUEST_ROLES } from '@/lib/api/require-auth';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import { guardPosting } from '@/lib/api/period-lock';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import { syncAssetStatusFromOpenRequests } from '@/lib/api/maintenance-helpers';
import { logger } from '@/lib/api/logger';
import { selfApprovalState } from '@/lib/api/stock-adjustment';
import {
  STOCK_REVERSALS_COLLECTION,
  approveStockReversal,
  cancelStockReversal,
  checkStockReversible,
  isStockReversalSourceType,
  rejectStockReversal,
  requestStockReversal,
  reversalActor,
  type StockReversalDoc,
} from '@/lib/api/stock-reversal';
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';
import type { JsonObject } from '@/types/json';

const LIST_LIMIT = 200;
const STATUSES = new Set(['PENDING_APPROVAL', 'POSTED', 'REJECTED', 'CANCELLED']);

function withoutCost<T extends { unitCost?: number }>(lines: T[] | undefined) {
  return (lines || []).map(({ unitCost: _u, ...l }) => {
    void _u;
    return l;
  });
}

function row(doc: StockReversalDoc, auth: AuthContext | null | undefined) {
  const { active: _active, ...rest } = doc;
  void _active;
  rest.lines = withoutCost(rest.lines) as StockReversalDoc['lines'];
  const pending = doc.status === 'PENDING_APPROVAL';
  const approver = !requireRole(auth, [...STOCK_REVERSAL_APPROVE_ROLES]);
  return {
    ...clean(rest as unknown as JsonObject),
    canApprove: pending && approver && selfApprovalState(auth, [doc.requestedBy]) !== 'blocked',
    canCancel: pending && (approver || doc.requestedBy?.userId === String(auth?.userId || '')),
  };
}

export async function handleStockReversals({ db, route, method, path, body, url, auth, request }: HandlerContext): Promise<NextResponse | null> {
  const revBody = (body || {}) as Record<string, unknown>;

  // GET /stock-reversals?status=&sourceType=&sourceId=
  if (route === '/stock-reversals' && method === 'GET') {
    const denied = requireRole(auth, [...STOCK_REVERSAL_REQUEST_ROLES]);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, request });
    if (scope.denied) return scope.denied;
    const filter: Record<string, unknown> = { tenantId: scope.tenantId };
    const status = String(url.searchParams.get('status') || '').trim();
    if (status && STATUSES.has(status)) filter.status = status;
    const sourceType = String(url.searchParams.get('sourceType') || '').trim();
    if (sourceType && isStockReversalSourceType(sourceType)) filter.sourceType = sourceType;
    const sourceId = String(url.searchParams.get('sourceId') || '').trim();
    if (sourceId) filter.sourceId = sourceId;
    const rows = await db.collection(STOCK_REVERSALS_COLLECTION).find(filter).sort({ createdAt: -1 }).limit(LIST_LIMIT).toArray();
    return ok((rows as unknown as StockReversalDoc[]).map((d) => row(d, auth)));
  }

  // GET /stock-reversals/check?sourceType=&sourceId=
  if (route === '/stock-reversals/check' && method === 'GET') {
    const denied = requireRole(auth, [...STOCK_REVERSAL_REQUEST_ROLES]);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, request });
    if (scope.denied) return scope.denied;
    const sourceType = String(url.searchParams.get('sourceType') || '').trim();
    const sourceId = String(url.searchParams.get('sourceId') || '').trim();
    if (!isStockReversalSourceType(sourceType)) return err('Jenis dokumen sumber tidak didukung', 400);
    if (!sourceId) return err('sourceId wajib', 400);
    const check = await checkStockReversible(db, scope.tenantId!, sourceType, sourceId);
    if (!check.ok) return ok({ reversible: false, reason: check.error });
    return ok({
      reversible: true,
      lines: withoutCost(check.lines.map(({ kartu: _k, ...l }) => {
        void _k;
        return l;
      })),
    });
  }

  // GET /stock-reversals/:id
  if (path[0] === 'stock-reversals' && path[1] && path.length === 2 && method === 'GET') {
    const denied = requireRole(auth, [...STOCK_REVERSAL_REQUEST_ROLES]);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, request });
    if (scope.denied) return scope.denied;
    const doc = await db.collection(STOCK_REVERSALS_COLLECTION).findOne({ tenantId: scope.tenantId, id: String(path[1]) });
    if (!doc) return err('Pengajuan pembalik tidak ditemukan', 404);
    return ok(row(doc as unknown as StockReversalDoc, auth));
  }

  // POST /stock-reversals { sourceType, sourceId, reason }
  if (route === '/stock-reversals' && method === 'POST') {
    const denied = requireRole(auth, [...STOCK_REVERSAL_REQUEST_ROLES]);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, body: revBody, request });
    if (scope.denied) return scope.denied;
    if (!auth?.userId) return err('Unauthorized', 401);
    const res = await requestStockReversal(db, {
      tenantId: scope.tenantId!,
      sourceType: revBody.sourceType,
      sourceId: revBody.sourceId,
      reason: revBody.reason,
      actor: reversalActor(auth),
    });
    if (!res.ok) return err(res.error, res.status);
    return ok(row(res.reversal, auth), 201);
  }

  // POST /stock-reversals/:id/approve|reject|cancel
  if (path[0] === 'stock-reversals' && path[1] && path[2] && path.length === 3 && method === 'POST') {
    const action = String(path[2]);
    if (!['approve', 'reject', 'cancel'].includes(action)) return null;
    const reversalId = String(path[1]);
    const roles = action === 'cancel' ? STOCK_REVERSAL_REQUEST_ROLES : STOCK_REVERSAL_APPROVE_ROLES;
    const denied = requireRole(auth, [...roles]);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, body: revBody, request });
    if (scope.denied) return scope.denied;
    if (!auth?.userId) return err('Unauthorized', 401);
    const tenantId = scope.tenantId!;

    if (action === 'approve') {
      const locked = await guardPosting(db, scope.scopeAuth, {}, new Date());
      if (locked) return locked;
      const res = await approveStockReversal(db, { tenantId, reversalId, auth });
      if (!res.ok) return err(res.error, res.status);
      if (res.reopenedWr?.assetId) {
        await syncAssetStatusFromOpenRequests(db, tenantId, res.reopenedWr.assetId).catch((e) => {
          logger.warn('stock_reversal_asset_sync_failed', { tenantId, error: e instanceof Error ? e.message : String(e) });
        });
      }
      if (!res.alreadyPosted) await invalidateDashboardSnapshot(db, tenantId);
      return ok({ ...row(res.reversal, auth), alreadyPosted: !!res.alreadyPosted });
    }
    const actor = reversalActor(auth);
    const res = action === 'reject'
      ? await rejectStockReversal(db, { tenantId, reversalId, reason: revBody.reason, actor })
      : await cancelStockReversal(db, { tenantId, reversalId, actor, canApprove: !requireRole(auth, [...STOCK_REVERSAL_APPROVE_ROLES]) });
    if (!res.ok) return err(res.error, res.status);
    return ok(row(res.reversal, auth));
  }

  return null;
}
