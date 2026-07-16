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
  DISTRIBUTION_ORDERS_COLLECTION,
  DIST_STATUS_TRANSITIONS,
  isDistEditable,
  normalizeDistLines,
  summarizeDistLines,
  allocatePorsiAcrossPoints,
  remainingSourceItems,
  assertDistQtyWithinSource,
  type DistributionOrderDoc,
  type DistributionStatus,
  type DistributionLine,
} from '@/lib/food-production/distribution';
import { SERVICE_POINTS_COLLECTION, type ServicePointDoc } from '@/lib/food-production/service-point';
import { PRODUCTION_PLANS_COLLECTION, type ProductionPlanDoc } from '@/lib/food-production/production-plan';
import { PRODUCTION_RESULTS_COLLECTION, type ProductionResultDoc } from '@/lib/food-production/production-result';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import { FP_MANAGE_ROLES } from '@/lib/food-production/roles';
import {
  FP_DOC_TYPES,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  nextFpDocNumber,
  type DocHistoryEntry,
  type FpDocStatus,
} from '@/lib/food-production/document';
import type { AuthContext } from '@/types/auth';
import type { HandlerContext } from '@/types/api/handler';

const KNOWN_STATUSES = new Set<string>(Object.keys(FP_DEFAULT_TRANSITIONS));

interface DistBody extends Record<string, unknown> {
  tanggal?: string;
  kitchenId?: string;
  sourceType?: string;
  productionPlanId?: string;
  productionResultId?: string;
  servicePointIds?: unknown;
  lines?: unknown;
  catatan?: string;
  status?: string;
  note?: string;
  allocate?: boolean;
}

type ScopeAuth = AuthContext;

function sourceItemsFromPlan(plan: ProductionPlanDoc) {
  return (plan.lines || []).map((l) => ({
    menuId: l.menuId,
    menuKode: l.menuKode,
    menuNama: l.menuNama,
    qtyPorsi: Number(l.targetPorsi) || 0,
  }));
}

function sourceItemsFromResult(result: ProductionResultDoc) {
  return (result.lines || []).map((l) => ({
    menuId: l.menuId,
    menuKode: l.menuKode,
    menuNama: l.menuNama || l.finishedGoodNama,
    finishedGoodProductId: l.finishedGoodProductId,
    finishedGoodKode: l.finishedGoodKode,
    finishedGoodNama: l.finishedGoodNama,
    qtyPorsi: Number(l.actualPorsi) || 0,
  }));
}

/**
 * Non-CANCELLED DST lines for the same source only (full scan — no arbitrary limit).
 * RESULT sources match by productionResultId alone; PLAN by productionPlanId alone.
 * Mixing Plan+Result keys would orphan menuId-only vs menuId|fgId lines.
 */
async function loadConsumedDistLinesForSource(
  db: HandlerContext['db'],
  scopeAuth: ScopeAuth,
  source: { productionPlanId?: string; productionResultId?: string },
  excludeId?: string,
): Promise<DistributionLine[]> {
  const sourceFilter: Record<string, unknown> = source.productionResultId
    ? { productionResultId: source.productionResultId }
    : source.productionPlanId
      ? { productionPlanId: source.productionPlanId }
      : {};
  if (!Object.keys(sourceFilter).length) return [];

  const filter: Record<string, unknown> = {
    status: { $ne: 'CANCELLED' },
    ...sourceFilter,
  };
  if (excludeId) filter.id = { $ne: excludeId };

  const docs = await db.collection(DISTRIBUTION_ORDERS_COLLECTION)
    .find(withTenantFilter(scopeAuth, filter))
    .project({ lines: 1 })
    .toArray() as unknown as Pick<DistributionOrderDoc, 'lines'>[];
  return docs.flatMap((d) => d.lines || []);
}

async function assertServicePointsForKitchen(
  db: HandlerContext['db'],
  scopeAuth: ScopeAuth,
  lines: DistributionLine[],
  kitchenId: string,
): Promise<string | null> {
  const ids = [...new Set(lines.map((l) => l.servicePointId).filter(Boolean))];
  if (!ids.length) return 'Tidak ada titik layanan pada baris';
  const points = await db.collection(SERVICE_POINTS_COLLECTION)
    .find(withTenantFilter(scopeAuth, { id: { $in: ids }, aktif: true }))
    .toArray() as unknown as ServicePointDoc[];
  if (points.length !== ids.length) {
    return 'Beberapa titik layanan tidak ditemukan / nonaktif';
  }
  for (const p of points) {
    if (p.kitchenId && p.kitchenId !== kitchenId) {
      return `Titik "${p.nama}" terikat dapur lain`;
    }
  }
  return null;
}

export async function handleDistributionOrders(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const distBody = (body || {}) as DistBody;

  if (route === '/distribution-orders' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const filter: Record<string, unknown> = {};
    const status = (url.searchParams.get('status') || '').trim();
    if (status) {
      if (!KNOWN_STATUSES.has(status)) return err('Filter status tidak valid', 400);
      filter.status = status;
    }
    const kitchenId = resolveKitchenIdFilter(url, request);
    if (kitchenId) filter.kitchenId = kitchenId;
    const planId = (url.searchParams.get('productionPlanId') || '').trim();
    if (planId) filter.productionPlanId = planId;
    const resultId = (url.searchParams.get('productionResultId') || '').trim();
    if (resultId) filter.productionResultId = resultId;

    const list = await db.collection(DISTRIBUTION_ORDERS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/distribution-orders' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: distBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const sourceType = String(distBody.sourceType || 'PLAN').toUpperCase() === 'RESULT'
      ? 'RESULT' as const
      : 'PLAN' as const;

    let plan: ProductionPlanDoc | null = null;
    let result: ProductionResultDoc | null = null;
    let kitchenId = '';
    let kitchenNama: string | undefined;
    let productionPlanId: string | undefined;
    let productionPlanNo: string | undefined;
    let productionResultId: string | undefined;
    let productionResultNo: string | undefined;
    let sourceItems: ReturnType<typeof sourceItemsFromPlan> = [];

    if (sourceType === 'RESULT') {
      const rid = String(distBody.productionResultId || '').trim();
      if (!rid) return err('productionResultId wajib untuk sumber HSL', 400);
      result = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: rid }),
      ) as ProductionResultDoc | null;
      if (!result) return err('Hasil produksi tidak ditemukan', 404);
      if (result.status !== 'COMPLETED') return err('HSL harus COMPLETED sebelum distribusi', 400);
      kitchenId = result.kitchenId;
      kitchenNama = result.kitchenNama;
      productionResultId = result.id;
      productionResultNo = result.noDokumen;
      productionPlanId = result.productionPlanId;
      productionPlanNo = result.productionPlanNo;
      sourceItems = sourceItemsFromResult(result);
    } else {
      const pid = String(distBody.productionPlanId || '').trim();
      if (!pid) return err('productionPlanId wajib untuk sumber rencana', 400);
      plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: pid }),
      ) as ProductionPlanDoc | null;
      if (!plan) return err('Rencana produksi tidak ditemukan', 404);
      if (!['APPROVED', 'PROCESSING', 'COMPLETED'].includes(plan.status)) {
        return err('Rencana harus APPROVED / PROCESSING / COMPLETED', 400);
      }
      kitchenId = plan.kitchenId;
      kitchenNama = plan.kitchenNama;
      productionPlanId = plan.id;
      productionPlanNo = plan.noDokumen;
      sourceItems = sourceItemsFromPlan(plan);
      // Prefer HSL once available — avoid double budget Plan+Result.
      const hslDone = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          productionPlanId: plan.id,
          status: 'COMPLETED',
        }),
        { projection: { id: 1, noDokumen: 1 } },
      );
      if (hslDone) {
        return err(
          `Rencana sudah punya HSL ${String(hslDone.noDokumen || '')} — buat DST dari Hasil Produksi`,
          400,
        );
      }
    }

    let lines: DistributionLine[];
    // Explicit lines take precedence over allocate / servicePointIds.
    if (Array.isArray(distBody.lines)) {
      const normalized = normalizeDistLines(distBody.lines);
      if ('error' in normalized) return err(normalized.error, 400);
      lines = normalized;
      const spErr = await assertServicePointsForKitchen(db, scopeAuth, lines, kitchenId);
      if (spErr) return err(spErr, 400);
    } else if (distBody.allocate !== false || Array.isArray(distBody.servicePointIds)) {
      const ids = [...new Set(
        (Array.isArray(distBody.servicePointIds) ? distBody.servicePointIds : [])
          .map(String)
          .filter(Boolean),
      )];
      if (!ids.length) return err('servicePointIds wajib untuk alokasi otomatis', 400);
      const points = await db.collection(SERVICE_POINTS_COLLECTION)
        .find(withTenantFilter(scopeAuth, { id: { $in: ids }, aktif: true }))
        .toArray() as unknown as ServicePointDoc[];
      if (points.length !== ids.length) return err('Beberapa titik layanan tidak valid', 400);
      for (const p of points) {
        if (p.kitchenId && p.kitchenId !== kitchenId) {
          return err(`Titik "${p.nama}" terikat dapur lain`, 400);
        }
      }
      // Allocate only remaining budget (prior non-CANCELLED DST for same source).
      const priorConsumed = await loadConsumedDistLinesForSource(db, scopeAuth, {
        productionPlanId,
        productionResultId,
      });
      const remainItems = remainingSourceItems(sourceItems, priorConsumed);
      if ('error' in remainItems) return err(remainItems.error, 400);
      const allocated = allocatePorsiAcrossPoints({
        items: remainItems,
        servicePoints: points.map((p) => ({
          id: p.id,
          kode: p.kode,
          nama: p.nama,
          kapasitasPorsi: p.kapasitasPorsi,
        })),
      });
      if ('error' in allocated) return err(allocated.error, 400);
      lines = allocated;
    } else {
      return err('Kirim lines atau servicePointIds untuk alokasi', 400);
    }

    // TOCTOU: re-load consumed immediately before insert.
    const consumed = await loadConsumedDistLinesForSource(db, scopeAuth, {
      productionPlanId,
      productionResultId,
    });
    const over = assertDistQtyWithinSource({
      sourceItems,
      newLines: lines,
      existingConsumedLines: consumed,
    });
    if (over) return err(over, 400);

    const actor = auditActor(auth);
    const now = new Date();
    const tenantId = tenantIdForWrite(scopeAuth, distBody);
    const noDokumen = await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.DISTRIBUTION_ORDER);
    const history: DocHistoryEntry[] = appendDocHistory([], {
      at: now,
      fromStatus: null,
      toStatus: 'DRAFT',
      userId: actor.userId,
      userName: actor.userName,
      note: sourceType === 'RESULT' ? 'Packing dari HSL' : 'Packing dari rencana',
    });

    const doc: DistributionOrderDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen,
      tanggal: String(distBody.tanggal || plan?.tanggal || result?.tanggal || '').trim()
        || new Date().toISOString().slice(0, 10),
      kitchenId,
      kitchenNama,
      sourceType,
      productionPlanId,
      productionPlanNo,
      productionResultId,
      productionResultNo,
      lines,
      status: 'DRAFT',
      history,
      summary: summarizeDistLines(lines),
      catatan: String(distBody.catatan || '').trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };

    // Final re-check then insert (narrow race window).
    const consumed2 = await loadConsumedDistLinesForSource(db, scopeAuth, {
      productionPlanId,
      productionResultId,
    });
    const over2 = assertDistQtyWithinSource({
      sourceItems,
      newLines: lines,
      existingConsumedLines: consumed2,
    });
    if (over2) return err(over2, 409);

    try {
      await db.collection(DISTRIBUTION_ORDERS_COLLECTION).insertOne(doc);
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err('Nomor dokumen bentrok — coba lagi', 409);
      }
      throw e;
    }

    await writeAuditLog(db, {
      tenantId,
      action: 'DIST_CREATE',
      entityType: 'distribution_order',
      entityId: doc.id,
      summary: `DST ${doc.noDokumen} dibuat (${sourceType})`,
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'distribution-orders' && path[1] && !path[2] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const doc = await db.collection(DISTRIBUTION_ORDERS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!doc) return err('Distribusi tidak ditemukan', 404);
    return ok(clean(doc as Record<string, unknown>));
  }

  if (path[0] === 'distribution-orders' && path[1] && !path[2] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: distBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(DISTRIBUTION_ORDERS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as DistributionOrderDoc | null;
    if (!existing) return err('Distribusi tidak ditemukan', 404);
    if (!isDistEditable(existing.status)) return err('Dokumen tidak dapat diubah', 400);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (distBody.lines != null) {
      const normalized = normalizeDistLines(distBody.lines);
      if ('error' in normalized) return err(normalized.error, 400);

      let sourceItems: ReturnType<typeof sourceItemsFromPlan> = [];
      if (existing.sourceType === 'RESULT' && existing.productionResultId) {
        const result = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { id: existing.productionResultId }),
        ) as ProductionResultDoc | null;
        if (!result) return err('Sumber HSL tidak ditemukan', 400);
        sourceItems = sourceItemsFromResult(result);
      } else if (existing.productionPlanId) {
        const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { id: existing.productionPlanId }),
        ) as ProductionPlanDoc | null;
        if (!plan) return err('Sumber rencana tidak ditemukan', 400);
        sourceItems = sourceItemsFromPlan(plan);
      } else {
        return err('Dokumen distribusi tanpa sumber', 400);
      }

      const spErr = await assertServicePointsForKitchen(
        db,
        scopeAuth,
        normalized,
        existing.kitchenId,
      );
      if (spErr) return err(spErr, 400);

      const consumed = await loadConsumedDistLinesForSource(db, scopeAuth, {
        productionPlanId: existing.productionPlanId,
        productionResultId: existing.productionResultId,
      }, id);
      const over = assertDistQtyWithinSource({
        sourceItems,
        newLines: normalized,
        existingConsumedLines: consumed,
      });
      if (over) return err(over, 400);
      update.lines = normalized;
      update.summary = summarizeDistLines(normalized);
    }
    if (distBody.catatan !== undefined) {
      update.catatan = String(distBody.catatan || '').trim() || null;
    }
    if (distBody.tanggal !== undefined) {
      update.tanggal = String(distBody.tanggal || '').trim();
    }

    await db.collection(DISTRIBUTION_ORDERS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: update },
    );
    const saved = await db.collection(DISTRIBUTION_ORDERS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    return ok(clean(saved as Record<string, unknown>));
  }

  if (path[0] === 'distribution-orders' && path[1] && path[2] === 'status' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: distBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const toStatus = String(distBody.status || '').trim() as DistributionStatus;
    if (!toStatus || !KNOWN_STATUSES.has(toStatus)) return err('status tidak valid', 400);

    const existing = await db.collection(DISTRIBUTION_ORDERS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as DistributionOrderDoc | null;
    if (!existing) return err('Distribusi tidak ditemukan', 404);
    if (existing.status === toStatus) {
      return ok(clean(existing as unknown as Record<string, unknown>));
    }
    const transitionErr = assertStatusTransition(existing.status, toStatus, DIST_STATUS_TRANSITIONS);
    if (transitionErr) return err(transitionErr, 400);

    const actor = auditActor(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: toStatus as FpDocStatus,
      userId: actor.userId,
      userName: actor.userName,
      note: String(distBody.note || '').trim()
        || (toStatus === 'PROCESSING' ? 'Dikirim ke titik layanan'
          : toStatus === 'COMPLETED' ? 'Diterima di titik layanan' : undefined),
    });

    await db.collection(DISTRIBUTION_ORDERS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { status: toStatus, history, updatedAt: now } },
    );
    const saved = await db.collection(DISTRIBUTION_ORDERS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: toStatus === 'COMPLETED' ? 'DIST_COMPLETE'
        : toStatus === 'CANCELLED' ? 'DIST_CANCEL' : 'DIST_STATUS',
      entityType: 'distribution_order',
      entityId: id,
      summary: `DST ${existing.noDokumen}: ${existing.status} → ${toStatus}`,
      ...auditActor(auth),
    });
    return ok(clean(saved as Record<string, unknown>));
  }

  if (path[0] === 'distribution-orders' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(DISTRIBUTION_ORDERS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as DistributionOrderDoc | null;
    if (!existing) return err('Distribusi tidak ditemukan', 404);
    if (existing.status === 'COMPLETED') return err('Distribusi diterima tidak dapat dibatalkan', 400);
    if (existing.status === 'CANCELLED') return ok({ id: path[1], status: 'CANCELLED' });
    const transitionErr = assertStatusTransition(existing.status, 'CANCELLED', DIST_STATUS_TRANSITIONS);
    if (transitionErr) return err(transitionErr, 400);

    const actor = auditActor(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: 'CANCELLED',
      userId: actor.userId,
      userName: actor.userName,
      note: 'Dibatalkan',
    });
    await db.collection(DISTRIBUTION_ORDERS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      { $set: { status: 'CANCELLED', history, updatedAt: now } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'DIST_CANCEL',
      entityType: 'distribution_order',
      entityId: path[1],
      summary: `DST ${existing.noDokumen} dibatalkan`,
      ...auditActor(auth),
    });
    return ok({ id: path[1], status: 'CANCELLED' });
  }

  return null;
}
