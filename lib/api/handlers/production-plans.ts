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
import {
  PRODUCTION_PLANS_COLLECTION,
  normalizePlanLines,
  isPlanEditable,
  isIsoDate,
  totalTargetPorsi,
  type ProductionPlanDoc,
  type ProductionPlanLine,
  type ProductionPlanStatus,
} from '@/lib/food-production/production-plan';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import { MENUS_COLLECTION } from '@/lib/food-production/menu';
import {
  FP_DOC_TYPES,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  nextFpDocNumber,
  type DocHistoryEntry,
  type FpDocStatus,
} from '@/lib/food-production/document';
import { todayIsoDate } from '@/lib/food-production/recipe';
import {
  MATERIAL_ISSUES_COLLECTION,
  ISSUE_OPEN_STATUSES,
} from '@/lib/food-production/material-issue';
import {
  PRODUCTION_RESULTS_COLLECTION,
  RESULT_OPEN_STATUSES,
  planCompleteGateMessage,
} from '@/lib/food-production/production-result';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;
const KNOWN_STATUSES = new Set<string>(Object.keys(FP_DEFAULT_TRANSITIONS));

interface PlanBody extends Record<string, unknown> {
  tanggal?: string;
  kitchenId?: string;
  lines?: unknown;
  catatan?: string;
  status?: string;
  note?: string;
}

async function enrichKitchen(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
  kitchenId: string,
  options?: { requireActive?: boolean },
): Promise<{ nama: string; warehouseKode?: string } | { error: string }> {
  const doc = await db.collection(KITCHENS_COLLECTION).findOne({
    ...tenantFilter,
    id: kitchenId,
  }) as { nama?: string; aktif?: boolean; defaultWarehouseKode?: string } | null;
  if (!doc) return { error: 'Dapur tidak ditemukan' };
  if (options?.requireActive !== false && doc.aktif === false) return { error: 'Dapur nonaktif' };
  return {
    nama: String(doc.nama || kitchenId),
    warehouseKode: doc.defaultWarehouseKode ? String(doc.defaultWarehouseKode) : undefined,
  };
}

async function enrichLines(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
  lines: ProductionPlanLine[],
  options?: { requireActive?: boolean; requireMenuItems?: boolean },
): Promise<ProductionPlanLine[] | { error: string }> {
  const ids = lines.map((l) => l.menuId);
  const menus = await db.collection(MENUS_COLLECTION)
    .find({ ...tenantFilter, id: { $in: ids } })
    .project({ id: 1, kode: 1, nama: 1, aktif: 1, version: 1, items: 1 })
    .toArray();
  const byId = new Map(menus.map((m) => [String(m.id), m]));
  const out: ProductionPlanLine[] = [];
  for (const line of lines) {
    const m = byId.get(line.menuId);
    if (!m) return { error: `Menu ${line.menuId} tidak ditemukan` };
    if (options?.requireActive !== false && m.aktif === false) {
      return { error: `Menu ${String(m.kode || line.menuId)} nonaktif` };
    }
    const items = Array.isArray(m.items) ? m.items : [];
    if (options?.requireMenuItems !== false && items.length === 0) {
      return { error: `Menu ${String(m.kode || line.menuId)} belum punya resep` };
    }
    out.push({
      ...line,
      menuKode: line.menuKode || (m.kode != null ? String(m.kode) : undefined),
      menuNama: line.menuNama || (m.nama != null ? String(m.nama) : undefined),
      menuVersion: Number(m.version) || line.menuVersion || 1,
    });
  }
  return out;
}

function actorFields(auth: HandlerContext['auth']): { userId?: string; userName?: string } {
  return auditActor(auth);
}

function projectPlan(doc: Record<string, unknown> | null) {
  if (!doc) return null;
  const lines = (doc.lines || []) as ProductionPlanLine[];
  return clean({
    ...doc,
    totalTargetPorsi: totalTargetPorsi(lines),
  });
}

export async function handleProductionPlans({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const planBody = (body || {}) as PlanBody;

  if (route === '/production-plans' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    let filter: Record<string, unknown> = {};
    const status = (url.searchParams.get('status') || '').trim();
    if (status) {
      if (!KNOWN_STATUSES.has(status)) return err('Filter status tidak valid', 400);
      filter.status = status;
    }
    const kitchenId = resolveKitchenIdFilter(url, request);
    if (kitchenId) filter.kitchenId = kitchenId;
    const tanggal = (url.searchParams.get('tanggal') || '').trim();
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    if (tanggal) {
      if (!isIsoDate(tanggal)) return err('Filter tanggal tidak valid (YYYY-MM-DD)', 400);
      filter.tanggal = tanggal;
    } else if (from || to) {
      if (from && !isIsoDate(from)) return err('Filter from tidak valid (YYYY-MM-DD)', 400);
      if (to && !isIsoDate(to)) return err('Filter to tidak valid (YYYY-MM-DD)', 400);
      filter.tanggal = {
        ...(from ? { $gte: from } : {}),
        ...(to ? { $lte: to } : {}),
      };
    }
    filter = withTenantFilter(scopeAuth, filter);

    const list = await db.collection(PRODUCTION_PLANS_COLLECTION)
      .find(filter)
      .sort({ tanggal: -1, createdAt: -1 })
      .limit(200)
      .toArray();

    return ok(list.map((doc) => projectPlan(doc as Record<string, unknown>)));
  }

  if (route === '/production-plans' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: planBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const tanggal = String(planBody.tanggal || '').trim() || todayIsoDate();
    if (!isIsoDate(tanggal)) return err('Tanggal tidak valid (YYYY-MM-DD)', 400);
    const kitchenId = String(planBody.kitchenId || '').trim();
    if (!kitchenId) return err('Dapur wajib dipilih');
    const linesRaw = normalizePlanLines(planBody.lines);
    if ('error' in linesRaw) return err(linesRaw.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, planBody);
    const tenantFilter = withTenantFilter(scopeAuth, {});
    const kitchen = await enrichKitchen(db, tenantFilter, kitchenId, { requireActive: true });
    if ('error' in kitchen) return err(kitchen.error, 400);
    const lines = await enrichLines(db, tenantFilter, linesRaw, {
      requireActive: true,
      requireMenuItems: true,
    });
    if ('error' in lines) return err(lines.error, 400);

    const now = new Date();
    const actor = actorFields(auth);
    const noDokumen = await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.PRODUCTION_PLAN);
    const history: DocHistoryEntry[] = appendDocHistory([], {
      at: now,
      fromStatus: null,
      toStatus: 'DRAFT',
      userId: actor.userId,
      userName: actor.userName,
      note: 'Rencana dibuat',
    });

    const doc: ProductionPlanDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen,
      tanggal,
      kitchenId,
      kitchenNama: kitchen.nama,
      kitchenWarehouseKode: kitchen.warehouseKode,
      lines,
      status: 'DRAFT',
      history,
      catatan: String(planBody.catatan || '').trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };
    await db.collection(PRODUCTION_PLANS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'PRODUCTION_PLAN_CREATE',
      entityType: 'production_plan',
      entityId: doc.id,
      summary: `Rencana ${doc.noDokumen} dibuat (${doc.tanggal})`,
      ...auditActor(auth),
    });
    return ok(projectPlan(doc as unknown as Record<string, unknown>));
  }

  // GET /production-plans/:id
  if (path[0] === 'production-plans' && path[1] && !path[2] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const id = path[1];
    const existing = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    if (!existing) return err('Rencana tidak ditemukan', 404);
    return ok(projectPlan(existing as Record<string, unknown>));
  }

  // PUT /production-plans/:id — edit header/lines (DRAFT/SUBMITTED only)
  if (path[0] === 'production-plans' && path[1] && !path[2] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: planBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as ProductionPlanDoc | null;
    if (!existing) return err('Rencana tidak ditemukan', 404);
    if (!isPlanEditable(existing.status)) {
      return err(`Rencana status ${existing.status} tidak dapat diubah`, 400);
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    const tenantFilter = withTenantFilter(scopeAuth, {});

    if (planBody.tanggal !== undefined) {
      const tanggal = String(planBody.tanggal).trim();
      if (!isIsoDate(tanggal)) return err('Tanggal tidak valid (YYYY-MM-DD)', 400);
      update.tanggal = tanggal;
    }
    if (planBody.kitchenId !== undefined) {
      const kitchenId = String(planBody.kitchenId).trim();
      if (!kitchenId) return err('Dapur wajib dipilih');
      const kitchen = await enrichKitchen(db, tenantFilter, kitchenId, { requireActive: true });
      if ('error' in kitchen) return err(kitchen.error, 400);
      update.kitchenId = kitchenId;
      update.kitchenNama = kitchen.nama;
      update.kitchenWarehouseKode = kitchen.warehouseKode || null;
    }
    if (planBody.lines !== undefined) {
      const linesRaw = normalizePlanLines(planBody.lines);
      if ('error' in linesRaw) return err(linesRaw.error, 400);
      const lines = await enrichLines(db, tenantFilter, linesRaw, {
        requireActive: existing.status === 'DRAFT',
        requireMenuItems: existing.status === 'DRAFT',
      });
      if ('error' in lines) return err(lines.error, 400);
      update.lines = lines;
    }
    if (planBody.catatan !== undefined) {
      update.catatan = String(planBody.catatan || '').trim() || null;
    }

    await db.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: update },
    );
    const saved = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'PRODUCTION_PLAN_UPDATE',
      entityType: 'production_plan',
      entityId: id,
      summary: `Rencana ${existing.noDokumen} diubah`,
      ...auditActor(auth),
    });
    return ok(projectPlan(saved as Record<string, unknown>));
  }

  // POST /production-plans/:id/status — { status, note? }
  if (path[0] === 'production-plans' && path[1] && path[2] === 'status' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: planBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const toStatus = String(planBody.status || '').trim() as ProductionPlanStatus;
    if (!toStatus) return err('status wajib');
    if (!KNOWN_STATUSES.has(toStatus)) return err('status tidak dikenal', 400);

    const existing = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as ProductionPlanDoc | null;
    if (!existing) return err('Rencana tidak ditemukan', 404);

    const transitionErr = assertStatusTransition(existing.status, toStatus);
    if (transitionErr) return err(transitionErr, 400);

    // Gate naik status: dapur & menu masih valid.
    if (toStatus === 'SUBMITTED' || toStatus === 'APPROVED') {
      const tenantFilter = withTenantFilter(scopeAuth, {});
      const kitchen = await enrichKitchen(db, tenantFilter, existing.kitchenId, { requireActive: true });
      if ('error' in kitchen) return err(kitchen.error, 400);
      const linesCheck = await enrichLines(db, tenantFilter, existing.lines || [], {
        requireActive: true,
        requireMenuItems: true,
      });
      if ('error' in linesCheck) return err(linesCheck.error, 400);
    }

    // Phase 2 kontrak: COMPLETED hanya jika PBL selesai + tidak ada Issue/Result terbuka.
    if (toStatus === 'COMPLETED') {
      const [completedIssue, openIssue, openResult] = await Promise.all([
        db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { productionPlanId: id, status: 'COMPLETED' }),
        ),
        db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
          withTenantFilter(scopeAuth, {
            productionPlanId: id,
            status: { $in: [...ISSUE_OPEN_STATUSES] },
          }),
        ),
        db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, {
            productionPlanId: id,
            status: { $in: [...RESULT_OPEN_STATUSES] },
          }),
        ),
      ]);
      const gateMsg = planCompleteGateMessage({
        hasCompletedIssue: Boolean(completedIssue),
        hasOpenIssue: Boolean(openIssue),
        hasOpenResult: Boolean(openResult),
      });
      if (gateMsg) return err(gateMsg, 400);
    }

    const actor = actorFields(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: toStatus as FpDocStatus,
      userId: actor.userId,
      userName: actor.userName,
      note: String(planBody.note || '').trim() || undefined,
    });

    await db.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { status: toStatus, history, updatedAt: now } },
    );
    const saved = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'PRODUCTION_PLAN_STATUS',
      entityType: 'production_plan',
      entityId: id,
      summary: `Rencana ${existing.noDokumen}: ${existing.status} → ${toStatus}`,
      ...auditActor(auth),
    });
    return ok(projectPlan(saved as Record<string, unknown>));
  }

  // DELETE = cancel (soft)
  if (path[0] === 'production-plans' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as ProductionPlanDoc | null;
    if (!existing) return err('Rencana tidak ditemukan', 404);
    if (existing.status === 'CANCELLED') return ok({ id, status: 'CANCELLED' });
    if (existing.status === 'COMPLETED') {
      return err('Rencana selesai tidak dapat dibatalkan', 400);
    }

    const transitionErr = assertStatusTransition(existing.status, 'CANCELLED');
    if (transitionErr) return err(transitionErr, 400);

    const actor = actorFields(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: 'CANCELLED',
      userId: actor.userId,
      userName: actor.userName,
      note: 'Dibatalkan',
    });

    await db.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { status: 'CANCELLED', history, updatedAt: now } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'PRODUCTION_PLAN_CANCEL',
      entityType: 'production_plan',
      entityId: id,
      summary: `Rencana ${existing.noDokumen} dibatalkan`,
      ...auditActor(auth),
    });
    return ok({ id, status: 'CANCELLED' });
  }

  return null;
}
