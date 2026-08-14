/**
 * HACCP Plan API — ADR-004 Fase 3.
 * Routes: /haccp-plans
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
  EXAMPLE_HACCP_PLAN_COOK,
  HACCP_PLANS_COLLECTION,
  HACCP_PLAN_TRANSITIONS,
  appendHaccpPlanHistory,
  assertHaccpPlanReadyForApproval,
  haccpPlanAllowsCloseoutEdit,
  haccpPlanAllowsStudyEdit,
  normalizeHaccpPlanEmbedded,
  normalizeHaccpPlanStatus,
  normalizeHaccpTeam,
  type HaccpPlanDoc,
  type HaccpPlanStatus,
} from '@/lib/food-production/haccp-plan';
import type { HandlerContext } from '@/types/api/handler';

function idList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
}

export async function handleHaccpPlans(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const b = (body || {}) as Record<string, unknown>;

  if (route === '/haccp-plans' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const status = url.searchParams.get('status') || undefined;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status.toUpperCase();
    const list = await db.collection(HACCP_PLANS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ updatedAt: -1 })
      .limit(100)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/haccp-plans/seed-example' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, b);

    const existing = await db.collection(HACCP_PLANS_COLLECTION).findOne({
      tenantId,
      kode: EXAMPLE_HACCP_PLAN_COOK.kode,
    });
    if (existing) {
      return ok(clean(existing as Record<string, unknown>));
    }

    const actor = auditActor(auth);
    const now = new Date();
    const doc: HaccpPlanDoc = {
      ...EXAMPLE_HACCP_PLAN_COOK,
      id: uuidv4(),
      tenantId,
      noDokumen: await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.HACCP_PLAN),
      history: appendHaccpPlanHistory([], {
        at: now,
        fromStatus: null,
        toStatus: 'DRAFT',
        userId: actor.userId,
        userName: actor.userName,
        note: 'Seed contoh HACCP plan',
      }),
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };
    await db.collection(HACCP_PLANS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'HACCP_PLAN_SEED',
      entityType: 'haccp_plan',
      entityId: doc.id,
      summary: `Seed contoh plan ${doc.kode}`,
      ...actor,
    });
    return ok(clean(doc as unknown as Record<string, unknown>), 201);
  }

  if (route === '/haccp-plans' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const kode = String(b.kode || '').trim().toUpperCase();
    const nama = String(b.nama || '').trim();
    if (!kode || !nama) return err('kode dan nama wajib', 400);

    const embedded = normalizeHaccpPlanEmbedded({
      processSteps: b.processSteps,
      hazards: b.hazards,
      ccps: b.ccps,
      criticalLimits: b.criticalLimits,
      monitoringPlans: b.monitoringPlans,
    });
    if ('error' in embedded) return err(embedded.error, 400);

    const teamIn = normalizeHaccpTeam(b.team);
    if ('error' in teamIn) return err(teamIn.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, b);
    const actor = auditActor(auth);
    const now = new Date();
    const doc: HaccpPlanDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen: await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.HACCP_PLAN),
      kode,
      nama,
      description: String(b.description || '').trim() || undefined,
      version: Number(b.version) > 0 ? Number(b.version) : 1,
      effectiveDate: String(b.effectiveDate || '').trim() || undefined,
      status: 'DRAFT',
      recipeIds: idList(b.recipeIds),
      menuIds: idList(b.menuIds),
      team: teamIn,
      scope: String(b.scope || '').trim() || undefined,
      productDescription: String(b.productDescription || '').trim() || undefined,
      intendedUse: String(b.intendedUse || '').trim() || undefined,
      flowDiagramNote: String(b.flowDiagramNote || '').trim() || undefined,
      flowDiagramUrls: idList(b.flowDiagramUrls),
      ...embedded,
      isExample: b.isExample === true,
      history: appendHaccpPlanHistory([], {
        at: now,
        fromStatus: null,
        toStatus: 'DRAFT',
        userId: actor.userId,
        userName: actor.userName,
        note: 'HACCP plan dibuat',
      }),
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };

    try {
      await db.collection(HACCP_PLANS_COLLECTION).insertOne(doc);
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err(`Kode plan ${kode} sudah dipakai`, 400);
      }
      throw e;
    }
    await writeAuditLog(db, {
      tenantId,
      action: 'HACCP_PLAN_CREATE',
      entityType: 'haccp_plan',
      entityId: doc.id,
      summary: `HACCP plan ${doc.kode} · ${doc.noDokumen}`,
      ...actor,
    });
    return ok(clean(doc as unknown as Record<string, unknown>), 201);
  }

  if (path[0] === 'haccp-plans' && path[1] && !path[2] && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    if (path[1] === 'seed-example') return err('Gunakan POST /haccp-plans/seed-example', 400);
    const existing = await db.collection(HACCP_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('HACCP plan tidak ditemukan', 404);
    return ok(clean(existing as Record<string, unknown>));
  }

  if (path[0] === 'haccp-plans' && path[1] && !path[2] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(HACCP_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as HaccpPlanDoc | null;
    if (!existing) return err('HACCP plan tidak ditemukan', 404);
    if (!haccpPlanAllowsCloseoutEdit(existing.status)) {
      return err(`Plan berstatus ${existing.status} tidak dapat diedit`, 400);
    }
    const studyEditable = haccpPlanAllowsStudyEdit(existing.status);

    const actor = auditActor(auth);
    const now = new Date();
    const patch: Record<string, unknown> = {
      updatedAt: now,
    };

    if (studyEditable) {
      const embedded = normalizeHaccpPlanEmbedded({
        processSteps: b.processSteps !== undefined ? b.processSteps : existing.processSteps,
        hazards: b.hazards !== undefined ? b.hazards : existing.hazards,
        ccps: b.ccps !== undefined ? b.ccps : existing.ccps,
        criticalLimits: b.criticalLimits !== undefined ? b.criticalLimits : existing.criticalLimits,
        monitoringPlans: b.monitoringPlans !== undefined ? b.monitoringPlans : existing.monitoringPlans,
      });
      if ('error' in embedded) return err(embedded.error, 400);
      Object.assign(patch, embedded);
      if (b.nama != null) {
        const nama = String(b.nama || '').trim();
        if (!nama) return err('nama wajib', 400);
        patch.nama = nama;
      }
      if (b.description !== undefined) {
        patch.description = String(b.description || '').trim() || null;
      }
      if (b.recipeIds !== undefined) patch.recipeIds = idList(b.recipeIds);
      if (b.menuIds !== undefined) patch.menuIds = idList(b.menuIds);
      if (b.team !== undefined) {
        const team = normalizeHaccpTeam(b.team);
        if ('error' in team) return err(team.error, 400);
        patch.team = team;
      }
      if (b.scope !== undefined) patch.scope = String(b.scope || '').trim() || null;
      if (b.productDescription !== undefined) {
        patch.productDescription = String(b.productDescription || '').trim() || null;
      }
      if (b.intendedUse !== undefined) {
        patch.intendedUse = String(b.intendedUse || '').trim() || null;
      }
      if (b.flowDiagramNote !== undefined) {
        patch.flowDiagramNote = String(b.flowDiagramNote || '').trim() || null;
      }
      if (b.flowDiagramUrls !== undefined) {
        patch.flowDiagramUrls = idList(b.flowDiagramUrls);
      }
      if (b.flowVerified === true) {
        const byName = String(b.flowVerifiedByName || '').trim()
          || actor.userName
          || '';
        if (!byName) {
          return err('Nama verifikator lapangan wajib saat menandai alur sudah dicek', 400);
        }
        patch.flowVerifiedAt = existing.flowVerifiedAt || now;
        patch.flowVerifiedBy = actor.userId;
        patch.flowVerifiedByName = byName;
        patch.flowVerifiedNote = String(b.flowVerifiedNote || '').trim() || null;
      } else if (b.flowVerified === false) {
        patch.flowVerifiedAt = null;
        patch.flowVerifiedBy = null;
        patch.flowVerifiedByName = null;
        patch.flowVerifiedNote = null;
      }
    }
    if (b.validationNote !== undefined) {
      patch.validationNote = String(b.validationNote || '').trim() || null;
    }
    if (b.validationEvidenceUrls !== undefined) {
      patch.validationEvidenceUrls = idList(b.validationEvidenceUrls);
    }
    if (b.markValidated === true) {
      const byName = String(b.validatedByName || '').trim() || actor.userName || '';
      if (!byName) return err('Nama validator wajib saat menandai rencana tervalidasi', 400);
      if (!String(b.validationNote ?? existing.validationNote || '').trim()
        && !idList(b.validationEvidenceUrls ?? existing.validationEvidenceUrls).length) {
        return err('Catatan atau foto validasi wajib', 400);
      }
      patch.validatedAt = existing.validatedAt || now;
      patch.validatedBy = actor.userId;
      patch.validatedByName = byName;
    }
    if (b.trainingNote !== undefined) {
      patch.trainingNote = String(b.trainingNote || '').trim() || null;
    }
    if (b.trainingEvidenceUrls !== undefined) {
      patch.trainingEvidenceUrls = idList(b.trainingEvidenceUrls);
    }
    if (b.effectiveDate !== undefined) {
      patch.effectiveDate = String(b.effectiveDate || '').trim() || null;
    }
    if (b.version != null && Number(b.version) > 0) patch.version = Number(b.version);

    patch.history = appendHaccpPlanHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: existing.status,
      userId: actor.userId,
      userName: actor.userName,
      note: String(b.note || '').trim() || 'Konten plan diperbarui',
    });

    await db.collection(HACCP_PLANS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      { $set: patch },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'HACCP_PLAN_UPDATE',
      entityType: 'haccp_plan',
      entityId: path[1],
      summary: `HACCP plan ${existing.kode} diperbarui`,
      ...actor,
    });
    const updated = await db.collection(HACCP_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    return ok(clean(updated as Record<string, unknown>));
  }

  if (path[0] === 'haccp-plans' && path[1] && path[2] === 'status' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(HACCP_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as HaccpPlanDoc | null;
    if (!existing) return err('HACCP plan tidak ditemukan', 404);

    const toStatus = normalizeHaccpPlanStatus(b.status);
    if (typeof toStatus !== 'string') return err(toStatus.error, 400);
    const gate = assertStatusTransition(
      existing.status,
      toStatus,
      HACCP_PLAN_TRANSITIONS as unknown as Record<string, string[]>,
    );
    if (gate) return err(gate, 400);

    if (toStatus === 'APPROVED' || toStatus === 'ACTIVE') {
      const ready = assertHaccpPlanReadyForApproval(existing);
      if (ready) return err(ready, 400);
    }

    const actor = auditActor(auth);
    const now = new Date();
    const patch: Record<string, unknown> = {
      status: toStatus,
      updatedAt: now,
      history: appendHaccpPlanHistory(existing.history, {
        at: now,
        fromStatus: existing.status,
        toStatus,
        userId: actor.userId,
        userName: actor.userName,
        note: String(b.note || '').trim() || `Status → ${toStatus}`,
      }),
    };

    if (toStatus === 'APPROVED') {
      patch.approvedAt = now;
      patch.approvedBy = actor.userId;
      patch.approvedByName = actor.userName;
    }
    if (toStatus === 'ACTIVE') {
      patch.activatedAt = now;
      patch.activatedBy = actor.userId;
      patch.activatedByName = actor.userName;
      if (!existing.effectiveDate) {
        patch.effectiveDate = now.toISOString().slice(0, 10);
      }
      // Supersede semua plan ACTIVE lain di tenant (MVP + unique partial ACTIVE).
      await db.collection(HACCP_PLANS_COLLECTION).updateMany(
        withTenantFilter(scopeAuth, {
          status: 'ACTIVE',
          id: { $ne: existing.id },
        }),
        {
          $set: {
            status: 'SUPERSEDED' as HaccpPlanStatus,
            supersededById: existing.id,
            updatedAt: now,
          },
        },
      );
    }

    try {
      await db.collection(HACCP_PLANS_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, { id: path[1] }),
        { $set: patch },
      );
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err('Sudah ada plan ACTIVE lain di tenant — supersede gagal / race condition', 409);
      }
      throw e;
    }
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'HACCP_PLAN_STATUS',
      entityType: 'haccp_plan',
      entityId: path[1],
      summary: `HACCP plan ${existing.kode} → ${toStatus}`,
      ...actor,
    });
    const updated = await db.collection(HACCP_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    return ok(clean(updated as Record<string, unknown>));
  }

  return null;
}
