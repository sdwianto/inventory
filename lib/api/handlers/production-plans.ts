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
  normalizeMaterialOverrides,
  upsertMaterialOverride,
  isPlanEditable,
  canEditPlanMaterials,
  isIsoDate,
  normalizeKategoriPorsiList,
  totalTargetPorsi,
  RECIPE_NEED_BUFFER_PCT,
  assertConsolidatePlans,
  mergeProductionPlanLines,
  mergeKategoriPorsiLists,
  mergeRecipeBufferPct,
  type ProductionPlanDoc,
  type ProductionPlanLine,
  type ProductionPlanStatus,
} from '@/lib/food-production/production-plan';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import { MENUS_COLLECTION } from '@/lib/food-production/menu';
import { RECIPES_COLLECTION } from '@/lib/food-production/recipe';
import {
  FP_DOC_TYPES,
  FP_DOC_PREFIX,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  type DocHistoryEntry,
  type FpDocStatus,
} from '@/lib/food-production/document';
import { nextDocNumber, nextFpDocNumber } from '@/lib/food-production/document-number';
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
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
  isMrpEditable,
} from '@/lib/food-production/material-requirement';
import {
  PURCHASE_REQUIREMENTS_COLLECTION,
  PR_ACTIVE_STATUSES,
} from '@/lib/food-production/purchase-requirement';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import { buildPlanMaterialExplosion } from '@/lib/api/handlers/material-requirements';
import {
  aggregatePlanMaterialConsumption,
  applyConsumptionToRequirementLines,
  loadPlanConsumptionSummary,
} from '@/lib/food-production/material-issue-reconcile';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;
const KNOWN_STATUSES = new Set<string>(Object.keys(FP_DEFAULT_TRANSITIONS));

interface PlanBody extends Record<string, unknown> {
  tanggal?: string;
  kitchenId?: string;
  kategoriPorsi?: string;
  kategoriPorsiList?: unknown;
  lines?: unknown;
  materialOverrides?: unknown;
  catatan?: string;
  tanggalKedatangan?: string;
  status?: string;
  note?: string;
  recipeId?: string;
  productId?: string;
  qty?: number | null;
  excluded?: boolean;
  fallbackQty?: number;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  clear?: boolean;
  bufferPct?: number | boolean;
  enabled?: boolean;
  ids?: unknown;
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
  const menuIds = [...new Set(lines.map((l) => String(l.menuId || '').trim()).filter(Boolean))];
  const recipeIds = [...new Set(lines.map((l) => String(l.recipeId || '').trim()).filter(Boolean))];

  const [menus, recipes] = await Promise.all([
    menuIds.length
      ? db.collection(MENUS_COLLECTION)
        .find({ ...tenantFilter, id: { $in: menuIds } })
        .project({ id: 1, kode: 1, nama: 1, aktif: 1, version: 1, items: 1 })
        .toArray()
      : Promise.resolve([]),
    recipeIds.length
      ? db.collection(RECIPES_COLLECTION)
        .find({ ...tenantFilter, id: { $in: recipeIds } })
        .project({ id: 1, kode: 1, nama: 1, aktif: 1, lines: 1 })
        .toArray()
      : Promise.resolve([]),
  ]);
  const menuById = new Map(menus.map((m) => [String(m.id), m]));
  const recipeById = new Map(recipes.map((r) => [String(r.id), r]));
  const out: ProductionPlanLine[] = [];

  for (const line of lines) {
    const recipeId = String(line.recipeId || '').trim();
    if (recipeId) {
      const r = recipeById.get(recipeId);
      if (!r) return { error: `Resep ${recipeId} tidak ditemukan` };
      if (options?.requireActive !== false && r.aktif === false) {
        return { error: `Resep ${String(r.kode || recipeId)} nonaktif` };
      }
      const rLines = Array.isArray(r.lines) ? r.lines : [];
      if (options?.requireMenuItems !== false && rLines.length === 0) {
        return { error: `Resep ${String(r.kode || recipeId)} belum punya bahan` };
      }
      out.push({
        recipeId,
        recipeKode: line.recipeKode || (r.kode != null ? String(r.kode) : undefined),
        recipeNama: line.recipeNama || (r.nama != null ? String(r.nama) : undefined),
        kategoriPorsiList: line.kategoriPorsiList,
        targetPorsi: line.targetPorsi,
        notes: line.notes,
      });
      continue;
    }

    const menuId = String(line.menuId || '').trim();
    const m = menuById.get(menuId);
    if (!m) return { error: `Menu ${menuId} tidak ditemukan` };
    if (options?.requireActive !== false && m.aktif === false) {
      return { error: `Menu ${String(m.kode || menuId)} nonaktif` };
    }
    const items = Array.isArray(m.items) ? m.items : [];
    if (options?.requireMenuItems !== false && items.length === 0) {
      return { error: `Menu ${String(m.kode || menuId)} belum punya resep` };
    }
    out.push({
      menuId,
      menuKode: line.menuKode || (m.kode != null ? String(m.kode) : undefined),
      menuNama: line.menuNama || (m.nama != null ? String(m.nama) : undefined),
      menuVersion: Number(m.version) || line.menuVersion || 1,
      kategoriPorsiList: line.kategoriPorsiList,
      targetPorsi: line.targetPorsi,
      notes: line.notes,
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
    const kategoriList = normalizeKategoriPorsiList(
      planBody.kategoriPorsiList ?? planBody.kategoriPorsi,
    );
    if ('error' in kategoriList) return err(kategoriList.error, 400);
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
      kategoriPorsi: kategoriList[0],
      kategoriPorsiList: kategoriList,
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

  // POST /production-plans/consolidate — gabung RPN dapur+tanggal yang sama
  if (path[0] === 'production-plans' && path[1] === 'consolidate' && !path[2] && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: planBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const rawIds = Array.isArray(planBody.ids) ? planBody.ids : [];
    const ids = [...new Set(rawIds.map((v) => String(v || '').trim()).filter(Boolean))];
    if (ids.length < 2) return err('Pilih minimal 2 rencana untuk digabung', 400);

    const found = await db.collection(PRODUCTION_PLANS_COLLECTION)
      .find(withTenantFilter(scopeAuth, { id: { $in: ids } }))
      .toArray() as unknown as ProductionPlanDoc[];
    if (found.length !== ids.length) return err('Ada rencana yang tidak ditemukan', 404);

    const byId = new Map(found.map((p) => [p.id, p]));
    const ordered = ids.map((id) => byId.get(id)!).sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      if (ta !== tb) return ta - tb;
      return String(a.noDokumen).localeCompare(String(b.noDokumen));
    });

    const asserted = assertConsolidatePlans(ordered.map((p) => ({
      id: p.id,
      noDokumen: p.noDokumen,
      tanggal: p.tanggal,
      kitchenId: p.kitchenId,
      status: p.status,
    })));
    if ('error' in asserted) return err(asserted.error, 400);

    const tenantIds = [...new Set(ordered.map((p) => String(p.tenantId || '')))];
    if (tenantIds.length !== 1) return err('Rencana harus dalam tenant yang sama', 400);

    const sourceIds = ordered.map((p) => p.id);
    const [blockingIssue, blockingResult, blockingPr, blockingMrp] = await Promise.all([
      db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          productionPlanId: { $in: sourceIds },
          status: { $nin: ['CANCELLED'] },
        }),
        { projection: { productionPlanId: 1, noDokumen: 1, status: 1 } },
      ),
      db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          productionPlanId: { $in: sourceIds },
          status: { $nin: ['CANCELLED'] },
        }),
        { projection: { productionPlanId: 1, noDokumen: 1, status: 1 } },
      ),
      db.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          productionPlanId: { $in: sourceIds },
          status: { $in: ['DRAFT', ...PR_ACTIVE_STATUSES, 'COMPLETED'] },
        }),
        { projection: { productionPlanId: 1, noDokumen: 1, status: 1 } },
      ),
      db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          productionPlanId: { $in: sourceIds },
          status: { $nin: ['CANCELLED', 'DRAFT', 'SUBMITTED'] },
        }),
        { projection: { productionPlanId: 1, noDokumen: 1, status: 1 } },
      ),
    ]);
    if (blockingIssue) {
      return err(
        `Tidak bisa gabung — ada pengeluaran stok ${String(blockingIssue.noDokumen || '')}`.trim(),
        400,
      );
    }
    if (blockingResult) {
      return err(
        `Tidak bisa gabung — ada hasil produksi ${String(blockingResult.noDokumen || '')}`.trim(),
        400,
      );
    }
    if (blockingPr) {
      return err(
        `Tidak bisa gabung — ada permintaan pembelian ${String(blockingPr.noDokumen || '')} yang masih aktif. Batalkan PR dulu.`,
        400,
      );
    }
    if (blockingMrp) {
      return err(
        `Tidak bisa gabung — MRP ${String(blockingMrp.noDokumen || '')} sudah ${String(blockingMrp.status)}. Batalkan MRP dulu.`,
        400,
      );
    }

    const mergedLinesRaw = mergeProductionPlanLines(ordered);
    const tenantFilter = withTenantFilter(scopeAuth, {});
    const lines = await enrichLines(db, tenantFilter, mergedLinesRaw, {
      requireActive: true,
      requireMenuItems: true,
    });
    if ('error' in lines) return err(lines.error, 400);
    const normalized = normalizePlanLines(lines);
    if ('error' in normalized) return err(normalized.error, 400);

    const kategoriList = mergeKategoriPorsiLists(
      ordered.map((p) => p.kategoriPorsiList?.length
        ? p.kategoriPorsiList
        : (p.kategoriPorsi ? [p.kategoriPorsi] : [])),
    );
    const fromLineKp = mergeKategoriPorsiLists(normalized.map((l) => l.kategoriPorsiList));
    const headerKp = kategoriList.length ? kategoriList : fromLineKp;
    if (!headerKp.length) return err('Minimal satu kategori porsi wajib dipilih', 400);

    const recipeBufferPct = mergeRecipeBufferPct(ordered.map((p) => p.recipeBufferPct));
    const sourceNos = ordered.map((p) => p.noDokumen);
    const catatan = `Digabung dari ${sourceNos.join(', ')}`;
    const tenantId = tenantIds[0];
    const actor = actorFields(auth);
    const first = ordered[0];

    let created: ProductionPlanDoc;
    try {
      created = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        const now = new Date();
        const noDokumen = await nextDocNumber(
          txDb,
          tenantId,
          FP_DOC_TYPES.PRODUCTION_PLAN,
          FP_DOC_PREFIX[FP_DOC_TYPES.PRODUCTION_PLAN],
          session,
        );
        const history: DocHistoryEntry[] = appendDocHistory([], {
          at: now,
          fromStatus: null,
          toStatus: 'DRAFT',
          userId: actor.userId,
          userName: actor.userName,
          note: catatan,
        });
        const doc: ProductionPlanDoc = {
          id: uuidv4(),
          tenantId,
          noDokumen,
          tanggal: asserted.tanggal,
          kitchenId: asserted.kitchenId,
          kitchenNama: first.kitchenNama,
          kitchenWarehouseKode: first.kitchenWarehouseKode,
          kategoriPorsi: headerKp[0],
          kategoriPorsiList: headerKp,
          lines: normalized,
          ...(recipeBufferPct ? { recipeBufferPct } : {}),
          consolidatedFromIds: sourceIds,
          consolidatedFromNos: sourceNos,
          status: 'DRAFT',
          history,
          catatan,
          createdAt: now,
          updatedAt: now,
          createdBy: actor.userId,
          createdByName: actor.userName,
        };
        await txDb.collection(PRODUCTION_PLANS_COLLECTION).insertOne(doc, txOpts(session));

        for (const src of ordered) {
          const srcHistory = appendDocHistory(src.history, {
            at: now,
            fromStatus: src.status,
            toStatus: 'CANCELLED',
            userId: actor.userId,
            userName: actor.userName,
            note: `Digabung ke ${noDokumen}`,
          });
          await txDb.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
            withTenantFilter(scopeAuth, { id: src.id }),
            {
              $set: {
                status: 'CANCELLED',
                history: srcHistory,
                consolidatedIntoId: doc.id,
                consolidatedIntoNo: noDokumen,
                updatedAt: now,
              },
            },
            txOpts(session),
          );
        }

        const draftMrps = await txDb.collection(MATERIAL_REQUIREMENTS_COLLECTION)
          .find(withTenantFilter(scopeAuth, {
            productionPlanId: { $in: sourceIds },
            status: { $in: ['DRAFT', 'SUBMITTED'] },
          }))
          .toArray();
        for (const mrp of draftMrps) {
          if (!isMrpEditable(String(mrp.status || ''))) continue;
          const mrpHistory = appendDocHistory(
            Array.isArray(mrp.history) ? mrp.history : [],
            {
              at: now,
              fromStatus: String(mrp.status || ''),
              toStatus: 'CANCELLED',
              userId: actor.userId,
              userName: actor.userName,
              note: `Dibatalkan karena RPN digabung ke ${noDokumen}`,
            },
          );
          await txDb.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateOne(
            withTenantFilter(scopeAuth, { id: mrp.id }),
            { $set: { status: 'CANCELLED', history: mrpHistory, updatedAt: now } },
            txOpts(session),
          );
        }

        return doc;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menggabungkan rencana';
      return err(msg, 500);
    }

    await writeAuditLog(db, {
      tenantId,
      action: 'PRODUCTION_PLAN_CONSOLIDATE',
      entityType: 'production_plan',
      entityId: created.id,
      summary: `Gabung ${sourceNos.join(', ')} → ${created.noDokumen}`,
      ...auditActor(auth),
    });
    return ok(projectPlan(created as unknown as Record<string, unknown>));
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
    if (planBody.kategoriPorsiList !== undefined || planBody.kategoriPorsi !== undefined) {
      const kategoriList = normalizeKategoriPorsiList(
        planBody.kategoriPorsiList ?? planBody.kategoriPorsi,
      );
      if ('error' in kategoriList) return err(kategoriList.error, 400);
      update.kategoriPorsi = kategoriList[0];
      update.kategoriPorsiList = kategoriList;
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
    if (planBody.materialOverrides !== undefined) {
      const overrides = normalizeMaterialOverrides(planBody.materialOverrides);
      if ('error' in overrides) return err(overrides.error, 400);
      update.materialOverrides = overrides;
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

  // POST /production-plans/:id/material-override — upsert/hapus 1 qty kebutuhan
  if (path[0] === 'production-plans' && path[1] && path[2] === 'material-override' && method === 'POST') {
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

    const linkedPo = await db.collection('customer_purchase_orders').findOne(
      withTenantFilter(scopeAuth, {
        productionPlanId: id,
        status: { $nin: ['CANCELLED'] },
      }),
      { sort: { createdAt: -1 }, projection: { status: 1 } },
    );
    const linkedPoStatus = linkedPo?.status ? String(linkedPo.status) : null;
    if (!canEditPlanMaterials(existing.status, linkedPoStatus)) {
      return err(
        linkedPoStatus && !['DRAFT', 'REJECTED'].includes(linkedPoStatus.toUpperCase())
          ? `Qty kebutuhan terkunci — PO sudah ${linkedPoStatus}`
          : `Qty kebutuhan hanya dapat diubah saat Draft/Diajukan atau Disetujui (PO belum final)`,
        400,
      );
    }

    const clear = planBody.clear === true;
    const next = upsertMaterialOverride(existing.materialOverrides, {
      recipeId: String(planBody.recipeId || ''),
      productId: String(planBody.productId || ''),
      clear,
      qty: planBody.qty !== undefined ? (planBody.qty as number | null) : undefined,
      excluded: planBody.excluded !== undefined ? planBody.excluded === true : undefined,
      fallbackQty: planBody.fallbackQty != null ? Number(planBody.fallbackQty) : undefined,
      productKode: planBody.productKode != null ? String(planBody.productKode) : undefined,
      productNama: planBody.productNama != null ? String(planBody.productNama) : undefined,
      satuan: planBody.satuan != null ? String(planBody.satuan) : undefined,
    });
    if ('error' in next) return err(next.error, 400);

    const now = new Date();
    await db.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { materialOverrides: next, updatedAt: now } },
    );
    const saved = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    const auditBit = clear
      ? `override dihapus (${planBody.productId})`
      : planBody.excluded === true
        ? `bahan dicoret (${planBody.productId})`
        : planBody.excluded === false
          ? `coret dibatalkan (${planBody.productId})`
          : `qty ${planBody.productId}=${planBody.qty}`;
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'PRODUCTION_PLAN_MATERIAL_OVERRIDE',
      entityType: 'production_plan',
      entityId: id,
      summary: `${auditBit} pada ${existing.noDokumen}`,
      ...auditActor(auth),
    });
    return ok(projectPlan(saved as Record<string, unknown>));
  }

  // POST /production-plans/:id/recipe-buffer — { recipeId, enabled?: boolean, bufferPct?: number }
  if (path[0] === 'production-plans' && path[1] && path[2] === 'recipe-buffer' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: planBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const recipeId = String(planBody.recipeId || '').trim();
    if (!recipeId) return err('recipeId wajib', 400);

    const existing = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as ProductionPlanDoc | null;
    if (!existing) return err('Rencana tidak ditemukan', 404);
    if (!isPlanEditable(existing.status)) {
      return err(`Buffer hanya dapat diubah saat Draft/Diajukan (status: ${existing.status})`, 400);
    }

    const lineHasRecipe = (existing.lines || []).some((l) => {
      if (l.recipeId === recipeId) return true;
      return false;
    });
    // Juga izinkan recipeId dari menu children — validasi lewat resep master.
    const recipe = await db.collection(RECIPES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: recipeId }),
      { projection: { id: 1, kode: 1 } },
    );
    if (!recipe && !lineHasRecipe) return err('Resep tidak ditemukan pada rencana', 404);

    let enabled = planBody.enabled;
    if (enabled === undefined) {
      if (planBody.bufferPct === false || planBody.bufferPct === 0) enabled = false;
      else if (planBody.bufferPct === true) enabled = true;
      else if (planBody.bufferPct != null) enabled = Number(planBody.bufferPct) > 0;
      else enabled = true;
    }
    const pct = enabled === false
      ? 0
      : (planBody.bufferPct != null && planBody.bufferPct !== true
        ? Math.round(Number(planBody.bufferPct))
        : RECIPE_NEED_BUFFER_PCT);
    if (enabled !== false && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
      return err('bufferPct tidak valid', 400);
    }

    const nextMap: Record<string, number> = { ...(existing.recipeBufferPct || {}) };
    if (enabled === false || pct <= 0) delete nextMap[recipeId];
    else nextMap[recipeId] = pct;

    const now = new Date();
    await db.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { recipeBufferPct: nextMap, updatedAt: now } },
    );
    const saved = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'PRODUCTION_PLAN_RECIPE_BUFFER',
      entityType: 'production_plan',
      entityId: id,
      summary: enabled === false || pct <= 0
        ? `Buffer resep ${recipeId} dimatikan pada ${existing.noDokumen}`
        : `Buffer ${pct}% resep ${recipeId} pada ${existing.noDokumen}`,
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

    // Mulai proses (Diproses): wajib sudah ada pengeluaran stok COMPLETED.
    // Shortage stok diabaikan setelah issue — bahan sudah diambil ke dapur.
    if (toStatus === 'PROCESSING') {
      const completedIssue = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { productionPlanId: id, status: 'COMPLETED' }),
      );
      if (!completedIssue) {
        const readiness = await buildPlanMaterialExplosion(db, scopeAuth, existing, { useLinkedPoAsTarget: true });
        if ('error' in readiness && readiness.error) return err(readiness.error, 400);
        const shortageCount = Number(readiness.summary?.shortageCount || 0);
        if (shortageCount > 0) {
          return err(
            `Tidak bisa mulai proses — masih kurang ${shortageCount} item bahan. Buat Draft Belanja atau lengkapi stok dulu.`,
            400,
          );
        }
        return err(
          'Tidak bisa mulai proses — barang belum dikeluarkan. Selesaikan Pengeluaran Stok (Keluarkan Stok) dulu.',
          400,
        );
      }
    }

    // COMPLETED: PBL selesai + HSL selesai + tidak ada Issue/Result terbuka.
    if (toStatus === 'COMPLETED') {
      const [completedIssue, openIssue, openResult, completedResult] = await Promise.all([
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
        db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { productionPlanId: id, status: 'COMPLETED' }),
        ),
      ]);
      const gateMsg = planCompleteGateMessage({
        hasCompletedIssue: Boolean(completedIssue),
        hasOpenIssue: Boolean(openIssue),
        hasOpenResult: Boolean(openResult),
        hasCompletedResult: Boolean(completedResult),
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

  // GET /production-plans/:id/material-readiness — stok lengkap vs kekurangan (live explode)
  if (path[0] === 'production-plans' && path[1] && path[2] === 'material-readiness' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as ProductionPlanDoc | null;
    if (!plan) return err('Rencana tidak ditemukan', 404);

    const built = await buildPlanMaterialExplosion(db, scopeAuth, plan, { useLinkedPoAsTarget: true });
    if ('error' in built && built.error) return err(built.error, 400);

    const consumption = await aggregatePlanMaterialConsumption(db, scopeAuth, id);
    const netLines = applyConsumptionToRequirementLines(built.lines || [], consumption);
    const shortageCount = netLines.summary.shortageCount;
    const stockReady = shortageCount === 0;
    // After stock is issued, on-hand drops — still treat as ready once PBL COMPLETED.
    const [linkedPo, completedIssue, openIssue, completedResult, openResult] = await Promise.all([
      db.collection('customer_purchase_orders').findOne(
        withTenantFilter(scopeAuth, {
          productionPlanId: id,
          status: { $nin: ['CANCELLED'] },
        }),
        { sort: { createdAt: -1 }, projection: { id: 1, noPO: 1, status: 1 } },
      ),
      db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { productionPlanId: id, status: 'COMPLETED' }),
        { projection: { id: 1, noDokumen: 1 } },
      ),
      db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          productionPlanId: id,
          status: { $in: [...ISSUE_OPEN_STATUSES] },
        }),
        { sort: { createdAt: -1 }, projection: { id: 1, noDokumen: 1, status: 1 } },
      ),
      db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { productionPlanId: id, status: 'COMPLETED' }),
        { projection: { id: 1, noDokumen: 1 } },
      ),
      db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          productionPlanId: id,
          status: { $in: [...RESULT_OPEN_STATUSES] },
        }),
        { sort: { createdAt: -1 }, projection: { id: 1, noDokumen: 1, status: 1 } },
      ),
    ]);

    const issueCompleted = Boolean(completedIssue);
    const materialsReady = stockReady || issueCompleted;
    const resultCompleted = Boolean(completedResult);
    const shortageLines = netLines.lines
      .filter((l) => l.shortage)
      .slice(0, 20)
      .map((l) => ({
        productId: l.productId,
        productKode: l.productKode,
        productNama: l.productNama,
        qtyGross: l.qtyGross,
        qtyOnHand: l.qtyOnHand,
        qtyNet: l.qtyNet,
        satuan: l.satuan,
        stockWarehouseKode: (l as { stockWarehouseKode?: string }).stockWarehouseKode,
        sourceOfTruth: l.sourceOfTruth,
        poQtyOrdered: l.poQtyOrdered,
        poQtyReceived: l.poQtyReceived,
      }));

    const consumptionSummary = await loadPlanConsumptionSummary(db, scopeAuth, id);

    return ok({
      productionPlanId: id,
      productionPlanNo: plan.noDokumen,
      materialsReady,
      shortageCount: issueCompleted ? 0 : shortageCount,
      lineCount: Number(built.summary?.lineCount || 0),
      warehouseKode: built.warehouseKode,
      shortageLines: issueCompleted ? [] : shortageLines,
      consumption: consumptionSummary,
      issueCompleted,
      completedIssueNo: completedIssue ? String(completedIssue.noDokumen || '') : null,
      resultCompleted,
      completedResultNo: completedResult ? String(completedResult.noDokumen || '') : null,
      openResult: openResult
        ? {
          id: String(openResult.id),
          noDokumen: String(openResult.noDokumen || ''),
          status: String(openResult.status || ''),
        }
        : null,
      openIssue: openIssue
        ? {
          id: String(openIssue.id),
          noDokumen: String(openIssue.noDokumen || ''),
          status: String(openIssue.status || ''),
        }
        : null,
      linkedPo: linkedPo
        ? {
          id: String(linkedPo.id),
          noPO: String(linkedPo.noPO || ''),
          status: String(linkedPo.status || ''),
        }
        : null,
    });
  }

  // POST /production-plans/:id/procure-shortage — explode → MRP → PR → Draft CPO (tanpa submit)
  if (path[0] === 'production-plans' && path[1] && path[2] === 'procure-shortage' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: planBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const { runProcureShortageFromPlan } = await import('@/lib/api/procure-shortage-run');
    const result = await runProcureShortageFromPlan(db, { auth, request, url }, {
      productionPlanId: path[1],
      scopeAuth,
      tanggalKedatangan: planBody.tanggalKedatangan
        ? String(planBody.tanggalKedatangan)
        : undefined,
      catatan: planBody.catatan ? String(planBody.catatan) : undefined,
    });
    if (!result.ok) return err(result.error, result.status || 400);
    return ok(result);
  }

  // POST /production-plans/:id/refresh-procure-draft — supersede PR+CPO Draft, buat draft baru
  if (path[0] === 'production-plans' && path[1] && path[2] === 'refresh-procure-draft' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: planBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const { runRefreshProcureDraftFromPlan } = await import('@/lib/api/procure-shortage-run');
    const result = await runRefreshProcureDraftFromPlan(db, { auth, request, url }, {
      productionPlanId: path[1],
      scopeAuth,
      tanggalKedatangan: planBody.tanggalKedatangan
        ? String(planBody.tanggalKedatangan)
        : undefined,
      catatan: planBody.catatan ? String(planBody.catatan) : undefined,
    });
    if (!result.ok) return err(result.error, result.status || 400);
    return ok(result);
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
