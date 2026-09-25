/** Fase 3.6 — pembalik GRN (RVS): daftar, cek kelayakan, ajukan, setujui, tolak, batal. */

import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { requireRole, GRN_REVERSAL_APPROVE_ROLES, GRN_REVERSAL_REQUEST_ROLES } from '@/lib/api/require-auth';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import { guardPosting } from '@/lib/api/period-lock';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import {
  GRN_REVERSALS_COLLECTION,
  approveGrnReversal,
  cancelGrnReversal,
  checkGrnReversible,
  grnReversalSelfApproveBlocked,
  rejectGrnReversal,
  requestGrnReversal,
  type GrnReversalActor,
  type GrnReversalDoc,
} from '@/lib/api/grn-reversal';
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';
import type { JsonObject } from '@/types/json';

const LIST_LIMIT = 200;
const STATUSES = new Set(['PENDING_APPROVAL', 'POSTED', 'REJECTED', 'CANCELLED']);

function actorOf(auth: AuthContext): GrnReversalActor {
  return {
    userId: String(auth.userId || ''),
    userName: String(auth.name || auth.email || ''),
    role: String(auth.role || ''),
    isMaster: !!auth.isMaster,
  };
}

function row(doc: GrnReversalDoc, auth: AuthContext | null | undefined) {
  const { active: _active, ...rest } = doc;
  void _active;
  const pending = doc.status === 'PENDING_APPROVAL';
  const actor = actorOf(auth!);
  const privileged = actor.isMaster || ['ADMIN', 'OWNER', 'MASTER'].includes(String(actor.role));
  return {
    ...clean(rest as unknown as JsonObject),
    canApprove: pending && !requireRole(auth, GRN_REVERSAL_APPROVE_ROLES) && !grnReversalSelfApproveBlocked(actor, doc),
    canCancel: pending && (privileged || doc.requestedBy?.userId === actor.userId),
  };
}

export async function handleGrnReversals({ db, route, method, path, body, url, auth, request }: HandlerContext): Promise<NextResponse | null> {
  const revBody = (body || {}) as Record<string, unknown>;

  // GET /grn-reversals?status=&grnId=
  if (route === '/grn-reversals' && method === 'GET') {
    const denied = requireRole(auth, GRN_REVERSAL_REQUEST_ROLES);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, request });
    if (scope.denied) return scope.denied;
    const filter: Record<string, unknown> = { tenantId: scope.tenantId };
    const status = String(url.searchParams.get('status') || '').trim();
    if (status && STATUSES.has(status)) filter.status = status;
    const grnId = String(url.searchParams.get('grnId') || '').trim();
    if (grnId) filter.grnId = grnId;
    const rows = await db.collection(GRN_REVERSALS_COLLECTION).find(filter).sort({ createdAt: -1 }).limit(LIST_LIMIT).toArray();
    return ok((rows as unknown as GrnReversalDoc[]).map((d) => row(d, auth)));
  }

  // GET /grn-reversals/check?grnId= — kelayakan pembalik (untuk UI sebelum mengajukan)
  if (route === '/grn-reversals/check' && method === 'GET') {
    const denied = requireRole(auth, GRN_REVERSAL_REQUEST_ROLES);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, request });
    if (scope.denied) return scope.denied;
    const tenantId = scope.tenantId!;
    const grnId = String(url.searchParams.get('grnId') || '').trim();
    if (!grnId) return err('grnId wajib', 400);
    const grn = await db.collection('goods_receipts').findOne({ ...tenantIdMatchFilter(tenantId), id: grnId }) as JsonObject | null;
    const check = await checkGrnReversible(db, tenantId, grn);
    if (!check.ok) return ok({ reversible: false, reason: check.error });
    return ok({
      reversible: check.groups.length > 0,
      ...(check.groups.length ? {} : { reason: 'GRN ini tidak punya qty diterima untuk dibalik' }),
      lines: check.groups.map(({ unitCost: _u, lotIds: _l, ...g }) => { void _u; void _l; return g; }),
    });
  }

  // GET /grn-reversals/:id
  if (path[0] === 'grn-reversals' && path[1] && path.length === 2 && method === 'GET') {
    const denied = requireRole(auth, GRN_REVERSAL_REQUEST_ROLES);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, request });
    if (scope.denied) return scope.denied;
    const doc = await db.collection(GRN_REVERSALS_COLLECTION).findOne({ tenantId: scope.tenantId, id: String(path[1]) });
    if (!doc) return err('Pengajuan pembalik tidak ditemukan', 404);
    return ok(row(doc as unknown as GrnReversalDoc, auth));
  }

  // POST /grn-reversals { grnId, reason }
  if (route === '/grn-reversals' && method === 'POST') {
    const denied = requireRole(auth, GRN_REVERSAL_REQUEST_ROLES);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, body: revBody, request });
    if (scope.denied) return scope.denied;
    if (!auth?.userId) return err('Unauthorized', 401);
    const res = await requestGrnReversal(db, {
      tenantId: scope.tenantId!,
      grnId: String(revBody.grnId || ''),
      reason: revBody.reason,
      actor: actorOf(auth),
    });
    if (!res.ok) return err(res.error, res.status);
    return ok(row(res.reversal, auth), 201);
  }

  // POST /grn-reversals/:id/approve|reject|cancel
  if (path[0] === 'grn-reversals' && path[1] && path[2] && method === 'POST') {
    const action = String(path[2]);
    const reversalId = String(path[1]);
    const roles = action === 'cancel' ? GRN_REVERSAL_REQUEST_ROLES : GRN_REVERSAL_APPROVE_ROLES;
    if (!['approve', 'reject', 'cancel'].includes(action)) return null;
    const denied = requireRole(auth, roles);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, body: revBody, request });
    if (scope.denied) return scope.denied;
    if (!auth?.userId) return err('Unauthorized', 401);
    const tenantId = scope.tenantId!;
    const actor = actorOf(auth);

    if (action === 'approve') {
      const locked = await guardPosting(db, scope.scopeAuth, revBody, new Date());
      if (locked) return locked;
      const res = await approveGrnReversal(db, { tenantId, reversalId, actor });
      if (!res.ok) return err(res.error, res.status);
      await invalidateDashboardSnapshot(db, tenantId);
      return ok({ ...row(res.reversal, auth), alreadyPosted: !!res.alreadyPosted });
    }
    const res = action === 'reject'
      ? await rejectGrnReversal(db, { tenantId, reversalId, reason: revBody.reason, actor })
      : await cancelGrnReversal(db, { tenantId, reversalId, actor });
    if (!res.ok) return err(res.error, res.status);
    return ok(row(res.reversal, auth));
  }

  return null;
}
