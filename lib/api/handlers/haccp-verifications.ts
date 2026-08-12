/**
 * HACCP Verification API — ADR-004 Fase 5.
 * Routes: /haccp-verifications
 */

import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { FP_MANAGE_ROLES, FP_OPS_WRITE_ROLES } from '@/lib/food-production/roles';
import { FP_DOC_TYPES, assertStatusTransition } from '@/lib/food-production/document';
import { nextFpDocNumber } from '@/lib/food-production/document-number';
import {
  HACCP_PLANS_COLLECTION,
  type HaccpPlanDoc,
} from '@/lib/food-production/haccp-plan';
import {
  HACCP_RESULTS_COLLECTION,
  type HaccpResultDoc,
} from '@/lib/food-production/haccp';
import {
  HACCP_VERIFICATIONS_COLLECTION,
  HACCP_VERIFICATION_TRANSITIONS,
  appendHaccpVerificationHistory,
  assertHaccpVerificationReady,
  normalizeHaccpVerificationResult,
  normalizeHaccpVerificationStatus,
  normalizeHaccpVerificationType,
  type HaccpVerificationDoc,
} from '@/lib/food-production/haccp-verification';
import type { HandlerContext } from '@/types/api/handler';

function evidenceList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
}

export async function handleHaccpVerifications(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const b = (body || {}) as Record<string, unknown>;

  if (route === '/haccp-verifications' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const type = url.searchParams.get('verificationType') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const filter: Record<string, unknown> = {};
    if (type) filter.verificationType = type.toUpperCase();
    if (status) filter.status = status.toUpperCase();
    const list = await db.collection(HACCP_VERIFICATIONS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ verifiedAt: -1, updatedAt: -1 })
      .limit(100)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/haccp-verifications' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const verificationType = normalizeHaccpVerificationType(b.verificationType);
    if (typeof verificationType !== 'string') return err(verificationType.error, 400);
    const result = normalizeHaccpVerificationResult(b.result ?? 'PARTIAL');
    if (typeof result !== 'string') return err(result.error, 400);
    const methodText = String(b.method || '').trim();
    if (!methodText) return err('method wajib', 400);

    const tenantId = tenantIdForWrite(scopeAuth, b);
    const actor = auditActor(auth);
    const now = new Date();
    const planId = String(b.haccpPlanId || '').trim() || undefined;
    const resultId = String(b.haccpResultId || '').trim() || undefined;

    let haccpPlanKode: string | undefined;
    let haccpResultNo: string | undefined;
    let productionBatchId: string | undefined;
    let kitchenId: string | undefined;

    if (planId) {
      const plan = await db.collection(HACCP_PLANS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: planId }),
      ) as HaccpPlanDoc | null;
      if (!plan) return err('HACCP plan tidak ditemukan', 404);
      haccpPlanKode = plan.kode;
    }
    if (resultId) {
      const hRes = await db.collection(HACCP_RESULTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: resultId }),
      ) as HaccpResultDoc | null;
      if (!hRes) return err('HACCP result tidak ditemukan', 404);
      haccpResultNo = hRes.noDokumen;
      productionBatchId = hRes.productionBatchId;
      kitchenId = hRes.kitchenId;
    }

    const completeNow = b.complete === true || String(b.status || '').toUpperCase() === 'COMPLETED';
    const evidenceUrls = evidenceList(b.evidenceUrls);
    const draft: Pick<
      HaccpVerificationDoc,
      | 'verificationType'
      | 'method'
      | 'result'
      | 'haccpPlanId'
      | 'haccpResultId'
      | 'evidenceUrls'
    > = {
      verificationType,
      method: methodText,
      result,
      haccpPlanId: planId,
      haccpResultId: resultId,
      evidenceUrls,
    };
    if (completeNow) {
      const ready = assertHaccpVerificationReady(draft);
      if (ready) return err(ready, 400);
    }

    const doc: HaccpVerificationDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen: await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.HACCP_VERIFICATION),
      verificationType,
      tanggal: String(b.tanggal || '').trim() || now.toISOString().slice(0, 10),
      method: methodText,
      result,
      status: completeNow ? 'COMPLETED' : 'DRAFT',
      haccpPlanId: planId,
      haccpPlanKode,
      haccpResultId: resultId,
      haccpResultNo,
      productionBatchId,
      kitchenId,
      note: String(b.note || '').trim() || undefined,
      evidenceUrls: evidenceUrls.length ? evidenceUrls : undefined,
      verifiedBy: actor.userId,
      verifiedByName: actor.userName,
      verifiedAt: now,
      history: appendHaccpVerificationHistory([], {
        at: now,
        fromStatus: null,
        toStatus: completeNow ? 'COMPLETED' : 'DRAFT',
        userId: actor.userId,
        userName: actor.userName,
        note: completeNow ? 'Verifikasi HACCP dicatat' : 'Draft verifikasi HACCP',
      }),
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };

    await db.collection(HACCP_VERIFICATIONS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'HACCP_VERIFICATION_CREATE',
      entityType: 'haccp_verification',
      entityId: doc.id,
      summary: `HV ${doc.noDokumen} · ${doc.verificationType} · ${doc.result}`,
      ...actor,
    });
    return ok(clean(doc as unknown as Record<string, unknown>), 201);
  }

  if (path[0] === 'haccp-verifications' && path[1] && !path[2] && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(HACCP_VERIFICATIONS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('Verifikasi tidak ditemukan', 404);
    return ok(clean(existing as Record<string, unknown>));
  }

  if (path[0] === 'haccp-verifications' && path[1] && path[2] === 'status' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(HACCP_VERIFICATIONS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as HaccpVerificationDoc | null;
    if (!existing) return err('Verifikasi tidak ditemukan', 404);

    const toStatus = normalizeHaccpVerificationStatus(b.status);
    if (typeof toStatus !== 'string') return err(toStatus.error, 400);
    const gate = assertStatusTransition(
      existing.status,
      toStatus,
      HACCP_VERIFICATION_TRANSITIONS as unknown as Record<string, string[]>,
    );
    if (gate) return err(gate, 400);

    if (toStatus === 'COMPLETED') {
      const ready = assertHaccpVerificationReady({
        ...existing,
        evidenceUrls: b.evidenceUrls != null
          ? evidenceList(b.evidenceUrls)
          : existing.evidenceUrls,
        method: b.method != null ? String(b.method).trim() : existing.method,
        result: typeof normalizeHaccpVerificationResult(b.result) === 'string'
          ? (normalizeHaccpVerificationResult(b.result) as HaccpVerificationDoc['result'])
          : existing.result,
      });
      if (ready) return err(ready, 400);
    }

    const actor = auditActor(auth);
    const now = new Date();
    const patch: Record<string, unknown> = {
      status: toStatus,
      updatedAt: now,
      verifiedAt: now,
      verifiedBy: actor.userId,
      verifiedByName: actor.userName,
      history: appendHaccpVerificationHistory(existing.history, {
        at: now,
        fromStatus: existing.status,
        toStatus,
        userId: actor.userId,
        userName: actor.userName,
        note: String(b.note || '').trim() || `Status → ${toStatus}`,
      }),
    };
    if (b.evidenceUrls != null) patch.evidenceUrls = evidenceList(b.evidenceUrls);
    if (b.method != null) patch.method = String(b.method).trim();
    if (b.result != null) {
      const r = normalizeHaccpVerificationResult(b.result);
      if (typeof r !== 'string') return err(r.error, 400);
      patch.result = r;
    }

    await db.collection(HACCP_VERIFICATIONS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      { $set: patch },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'HACCP_VERIFICATION_STATUS',
      entityType: 'haccp_verification',
      entityId: path[1],
      summary: `HV ${existing.noDokumen} → ${toStatus}`,
      ...actor,
    });
    const updated = await db.collection(HACCP_VERIFICATIONS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    return ok(clean(updated as Record<string, unknown>));
  }

  return null;
}
