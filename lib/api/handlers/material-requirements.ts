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
  MATERIAL_REQUIREMENTS_COLLECTION,
  explodeMaterialRequirements,
  isMrpEditable,
  decideMrpRegenerateMode,
  MRP_ELIGIBLE_PLAN_STATUSES,
  type MaterialRequirementDoc,
  type MaterialRequirementStatus,
} from '@/lib/food-production/material-requirement';
import {
  PRODUCTION_PLANS_COLLECTION,
  cookDateFromPlanTanggal,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import { MENUS_COLLECTION, type MenuDoc } from '@/lib/food-production/menu';
import { RECIPES_COLLECTION, applyFullPortionExceptions, type RecipeDoc } from '@/lib/food-production/recipe';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import {
  PORTION_TARGETS_COLLECTION,
  emptyPortionTargets,
  type PortionTargetDoc,
} from '@/lib/food-production/portion-target';
import {
  MATERIAL_ISSUES_COLLECTION,
} from '@/lib/food-production/material-issue';
import {
  PURCHASE_REQUIREMENTS_COLLECTION,
  PR_ACTIVE_STATUSES,
} from '@/lib/food-production/purchase-requirement';
import { getStokByWarehouseBatch } from '@/lib/api/stok-lokasi';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import {
  FP_DOC_TYPES,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  type DocHistoryEntry,
  type FpDocStatus,
} from '@/lib/food-production/document';
import { nextFpDocNumber } from '@/lib/food-production/document-number';
import { loadRecipePortionExceptionSet } from '@/lib/api/handlers/recipe-portion-exceptions';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;
const KNOWN_STATUSES = new Set<string>(Object.keys(FP_DEFAULT_TRANSITIONS));
/** PR DRAFT juga memblokir regenerate — qtyNet sudah dipakai draft pengadaan. */
const PR_BLOCKING_STATUSES = ['DRAFT', ...PR_ACTIVE_STATUSES] as const;

interface MrpBody extends Record<string, unknown> {
  productionPlanId?: string;
  catatan?: string;
  status?: string;
  note?: string;
}

function actorFields(auth: HandlerContext['auth']) {
  return auditActor(auth);
}

function projectMrp(doc: Record<string, unknown> | null) {
  if (!doc) return null;
  return clean(doc);
}

/** Exported for plan material-readiness / procure orchestration. */
export async function buildPlanMaterialExplosion(
  db: HandlerContext['db'],
  scopeAuth: Parameters<typeof withTenantFilter>[0],
  plan: ProductionPlanDoc,
) {
  return buildExplosion(db, scopeAuth, plan);
}

async function buildExplosion(
  db: HandlerContext['db'],
  scopeAuth: Parameters<typeof withTenantFilter>[0],
  plan: ProductionPlanDoc,
) {
  const tenantFilter = withTenantFilter(scopeAuth, {});
  let warehouseKode = String(plan.kitchenWarehouseKode || '').trim();
  if (!warehouseKode) {
    const kitchen = await db.collection(KITCHENS_COLLECTION).findOne({
      ...tenantFilter,
      id: plan.kitchenId,
    }) as { defaultWarehouseKode?: string } | null;
    warehouseKode = String(kitchen?.defaultWarehouseKode || '').trim();
  }
  if (!warehouseKode) {
    return { error: 'Dapur belum punya gudang default' as const };
  }

  const menuIds = [...new Set(
    (plan.lines || []).map((l) => String(l.menuId || '').trim()).filter(Boolean),
  )];
  const menus = menuIds.length
    ? await db.collection(MENUS_COLLECTION)
      .find({ ...tenantFilter, id: { $in: menuIds } })
      .toArray() as unknown as MenuDoc[]
    : [];
  if (menus.length !== menuIds.length) {
    const found = new Set(menus.map((m) => m.id));
    const missing = menuIds.find((id) => !found.has(id));
    return { error: `Menu ${missing} tidak ditemukan` as const };
  }
  const menusById = new Map(menus.map((m) => [m.id, m]));

  const recipeIdsFromLines = (plan.lines || [])
    .map((l) => String(l.recipeId || '').trim())
    .filter(Boolean);
  const recipeIdsFromMenus = menus.flatMap((m) => (m.items || []).map((i) => i.recipeId));
  const recipeIds = [...new Set([...recipeIdsFromLines, ...recipeIdsFromMenus])];
  const recipes = recipeIds.length
    ? await db.collection(RECIPES_COLLECTION)
      .find({ ...tenantFilter, id: { $in: recipeIds } })
      .toArray() as unknown as RecipeDoc[]
    : [];
  if (recipeIds.length && recipes.length !== recipeIds.length) {
    const found = new Set(recipes.map((r) => r.id));
    const missing = recipeIds.find((id) => !found.has(id));
    return { error: `Resep ${missing} tidak ditemukan` as const };
  }
  const recipesById = new Map(recipes.map((r) => [r.id, r]));

  const productIds = [...new Set(
    recipes.flatMap((r) => (r.lines || []).map((l) => l.productId)),
  )];
  const tid = tenantIdForWrite(scopeAuth, {});

  // Enrich names + resolve each SKU's warehouse (buah/basah → GBASAH, not kitchen GKERING)
  const products = await db.collection('products')
    .find({ ...tenantFilter, id: { $in: productIds } })
    .project({ id: 1, kode: 1, nama: 1, satuan: 1, gudangKode: 1, grup: 1 })
    .toArray();
  const productById = new Map(products.map((p) => [String(p.id), p]));
  for (const recipe of recipes) {
    for (const line of recipe.lines || []) {
      const p = productById.get(line.productId);
      if (!p) continue;
      if (!line.productKode && p.kode != null) line.productKode = String(p.kode);
      if (!line.productNama && p.nama != null) line.productNama = String(p.nama);
      if (!line.satuan && p.satuan != null) line.satuan = String(p.satuan);
    }
  }

  const exceptionKeys = await loadRecipePortionExceptionSet(db, tenantFilter);
  if (exceptionKeys.size) {
    for (const recipe of recipes) {
      recipe.lines = applyFullPortionExceptions(recipe.lines, exceptionKeys);
    }
  }

  const stockMap = await getStokByWarehouseBatch(db, tid, productIds);
  const onHandByProduct = new Map<string, number>();
  const stockWarehouseByProduct = new Map<string, string>();
  for (const pid of productIds) {
    const prod = productById.get(pid) as { gudangKode?: string } | undefined;
    // On-hand must match where GRN posts (product gudang), not kitchen default alone.
    const stockWh = resolveProductGudangKode(prod);
    const byWh = stockMap.get(pid) || {};
    onHandByProduct.set(pid, Number(byWh[stockWh] || 0));
    stockWarehouseByProduct.set(pid, stockWh);
  }

  // Acuan porsi tanggal/dapur — pecah kebutuhan besar vs kecil secara akurat
  const portionDoc = await db.collection(PORTION_TARGETS_COLLECTION).findOne(
    { ...tenantFilter, tanggal: plan.tanggal, kitchenId: plan.kitchenId },
  ) as PortionTargetDoc | null;
  const acuanByKategori = portionDoc?.targets
    ? { ...emptyPortionTargets(), ...portionDoc.targets }
    : undefined;

  const exploded = explodeMaterialRequirements({
    plan,
    menusById,
    recipesById,
    onHandByProduct,
    warehouseKode,
    acuanByKategori,
  });
  if (!exploded.ok) return { error: exploded.error };
  const lines = exploded.lines.map((l) => ({
    ...l,
    stockWarehouseKode: stockWarehouseByProduct.get(l.productId) || warehouseKode,
  }));
  return {
    warehouseKode,
    lines,
    summary: exploded.summary,
    acuanByKategori: acuanByKategori || null,
  };
}

async function loadLatestOpenMrp(
  db: HandlerContext['db'],
  scopeAuth: Parameters<typeof withTenantFilter>[0],
  productionPlanId: string,
): Promise<MaterialRequirementDoc | null> {
  return db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, {
      productionPlanId,
      status: { $nin: ['CANCELLED'] },
    }),
    { sort: { createdAt: -1 } },
  ) as Promise<MaterialRequirementDoc | null>;
}

async function mrpRegenerateBlockers(
  db: HandlerContext['db'],
  scopeAuth: Parameters<typeof withTenantFilter>[0],
  productionPlanId: string,
  mrpIds: string[],
): Promise<{ hasBlockingIssue: boolean; hasBlockingPr: boolean }> {
  const issue = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
    withTenantFilter(scopeAuth, {
      productionPlanId,
      status: { $nin: ['CANCELLED'] },
    }),
    { projection: { id: 1 } },
  );
  let hasBlockingPr = false;
  if (mrpIds.length) {
    const pr = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, {
        materialRequirementId: { $in: mrpIds },
        status: { $in: [...PR_BLOCKING_STATUSES] },
      }),
      { projection: { id: 1 } },
    );
    hasBlockingPr = Boolean(pr);
  }
  return { hasBlockingIssue: Boolean(issue), hasBlockingPr };
}

export async function handleMaterialRequirements({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const mrpBody = (body || {}) as MrpBody;

  if (route === '/material-requirements' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    let filter: Record<string, unknown> = {};
    const status = (url.searchParams.get('status') || '').trim();
    if (status) {
      if (!KNOWN_STATUSES.has(status)) return err('Filter status tidak valid', 400);
      filter.status = status;
    }
    const planId = (url.searchParams.get('productionPlanId') || '').trim();
    if (planId) filter.productionPlanId = planId;
    const tanggal = (url.searchParams.get('tanggal') || '').trim();
    if (tanggal) filter.tanggal = tanggal;
    filter = withTenantFilter(scopeAuth, filter);

    const list = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION)
      .find(filter)
      .sort({ tanggal: -1, createdAt: -1 })
      .limit(200)
      .toArray();

    return ok(list.map((doc) => projectMrp(doc as Record<string, unknown>)));
  }

  if (route === '/material-requirements' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: mrpBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const productionPlanId = String(mrpBody.productionPlanId || '').trim();
    if (!productionPlanId) return err('productionPlanId wajib');

    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: productionPlanId }),
    ) as ProductionPlanDoc | null;
    if (!plan) return err('Rencana produksi tidak ditemukan', 404);
    if (!MRP_ELIGIBLE_PLAN_STATUSES.has(plan.status)) {
      return err(`Rencana status ${plan.status} belum siap untuk MRP (minimal Diajukan)`, 400);
    }

    const built = await buildExplosion(db, scopeAuth, plan);
    if ('error' in built && built.error) return err(built.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, mrpBody);
    const now = new Date();
    const actor = actorFields(auth);
    const noDokumen = await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.MATERIAL_REQUIREMENT);
    const history: DocHistoryEntry[] = appendDocHistory([], {
      at: now,
      fromStatus: null,
      toStatus: 'DRAFT',
      userId: actor.userId,
      userName: actor.userName,
      note: `Dihitung dari rencana ${plan.noDokumen}`,
    });

    // Batalkan draft MRP lama untuk plan yang sama (supersede).
    await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateMany(
      withTenantFilter(scopeAuth, {
        productionPlanId,
        status: 'DRAFT',
      }),
      { $set: { status: 'CANCELLED', updatedAt: now } },
    );

    const doc: MaterialRequirementDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen,
      productionPlanId: plan.id,
      productionPlanNo: plan.noDokumen,
      tanggal: cookDateFromPlanTanggal(plan.tanggal),
      kitchenId: plan.kitchenId,
      kitchenNama: plan.kitchenNama,
      warehouseKode: built.warehouseKode!,
      lines: built.lines!,
      status: 'DRAFT',
      history,
      summary: built.summary!,
      acuanByKategori: built.acuanByKategori ?? null,
      catatan: String(mrpBody.catatan || '').trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };
    await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'MRP_CREATE',
      entityType: 'material_requirement',
      entityId: doc.id,
      summary: `MRP ${doc.noDokumen} dari ${plan.noDokumen} (${doc.summary.shortageCount} kekurangan)`,
      ...auditActor(auth),
    });
    return ok(projectMrp(doc as unknown as Record<string, unknown>));
  }

  // POST /material-requirements/regenerate-for-plan — hitung ulang dengan acuan porsi terkini
  if (route === '/material-requirements/regenerate-for-plan' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: mrpBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const productionPlanId = String(mrpBody.productionPlanId || '').trim();
    if (!productionPlanId) return err('productionPlanId wajib');

    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: productionPlanId }),
    ) as ProductionPlanDoc | null;
    if (!plan) return err('Rencana produksi tidak ditemukan', 404);
    if (!MRP_ELIGIBLE_PLAN_STATUSES.has(plan.status)) {
      return err(`Rencana status ${plan.status} belum siap untuk MRP (minimal Diajukan)`, 400);
    }

    const existing = await loadLatestOpenMrp(db, scopeAuth, productionPlanId);
    const relatedMrpIds = existing ? [existing.id] : [];
    // Juga cek PR pada MRP lain plan yang sama (SUBMITTED/APPROVED lama)
    const siblingMrps = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION)
      .find(
        withTenantFilter(scopeAuth, {
          productionPlanId,
          status: { $nin: ['CANCELLED'] },
        }),
        { projection: { id: 1 } },
      )
      .toArray();
    const allMrpIds = [...new Set([
      ...relatedMrpIds,
      ...siblingMrps.map((d) => String(d.id)),
    ])];

    const blockers = await mrpRegenerateBlockers(db, scopeAuth, productionPlanId, allMrpIds);
    const decision = decideMrpRegenerateMode({
      existingStatus: existing?.status,
      hasBlockingIssue: blockers.hasBlockingIssue,
      hasBlockingPr: blockers.hasBlockingPr,
    });
    if (decision.mode === 'blocked') {
      return err(decision.error || 'MRP tidak dapat dihitung ulang', 400);
    }

    const built = await buildExplosion(db, scopeAuth, plan);
    if ('error' in built && built.error) return err(built.error, 400);

    const actor = actorFields(auth);
    const now = new Date();
    const tenantId = tenantIdForWrite(scopeAuth, mrpBody);
    const acuanNote = built.acuanByKategori
      ? 'dengan acuan porsi tanggal/dapur'
      : 'tanpa acuan porsi (pecah proporsional)';

    if (decision.mode === 'recalculate' && existing) {
      const history = appendDocHistory(existing.history, {
        at: now,
        fromStatus: existing.status,
        toStatus: existing.status,
        userId: actor.userId,
        userName: actor.userName,
        note: `Dihitung ulang ${acuanNote}`,
      });
      await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, { id: existing.id }),
        {
          $set: {
            lines: built.lines,
            summary: built.summary,
            warehouseKode: built.warehouseKode,
            tanggal: cookDateFromPlanTanggal(plan.tanggal),
            kitchenId: plan.kitchenId,
            kitchenNama: plan.kitchenNama,
            productionPlanNo: plan.noDokumen,
            acuanByKategori: built.acuanByKategori ?? null,
            history,
            updatedAt: now,
          },
        },
      );
      const saved = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: existing.id }),
      );
      await writeAuditLog(db, {
        tenantId: existing.tenantId,
        action: 'MRP_REGENERATE',
        entityType: 'material_requirement',
        entityId: existing.id,
        summary: `MRP ${existing.noDokumen} dihitung ulang ${acuanNote}`,
        ...auditActor(auth),
      });
      return ok({
        mode: 'recalculate',
        mrp: projectMrp(saved as Record<string, unknown>),
        acuanApplied: Boolean(built.acuanByKategori),
      });
    }

    // create | supersede → dokumen baru DRAFT; supersede batalkan yang lama
    if (decision.mode === 'supersede' && existing) {
      const cancelHistory = appendDocHistory(existing.history, {
        at: now,
        fromStatus: existing.status,
        toStatus: 'CANCELLED',
        userId: actor.userId,
        userName: actor.userName,
        note: 'Diganti MRP baru (hitung ulang acuan porsi)',
      });
      await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, { id: existing.id }),
        { $set: { status: 'CANCELLED', history: cancelHistory, updatedAt: now } },
      );
    }

    await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateMany(
      withTenantFilter(scopeAuth, {
        productionPlanId,
        status: 'DRAFT',
        ...(existing ? { id: { $ne: existing.id } } : {}),
      }),
      { $set: { status: 'CANCELLED', updatedAt: now } },
    );

    const noDokumen = await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.MATERIAL_REQUIREMENT);
    const history: DocHistoryEntry[] = appendDocHistory([], {
      at: now,
      fromStatus: null,
      toStatus: 'DRAFT',
      userId: actor.userId,
      userName: actor.userName,
      note: existing
        ? `Menggantikan ${existing.noDokumen} — dihitung ulang ${acuanNote}`
        : `Dihitung dari rencana ${plan.noDokumen} ${acuanNote}`,
    });
    const doc: MaterialRequirementDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen,
      productionPlanId: plan.id,
      productionPlanNo: plan.noDokumen,
      tanggal: cookDateFromPlanTanggal(plan.tanggal),
      kitchenId: plan.kitchenId,
      kitchenNama: plan.kitchenNama,
      warehouseKode: built.warehouseKode!,
      lines: built.lines!,
      status: 'DRAFT',
      history,
      summary: built.summary!,
      acuanByKategori: built.acuanByKategori ?? null,
      catatan: String(mrpBody.catatan || '').trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };
    await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'MRP_REGENERATE',
      entityType: 'material_requirement',
      entityId: doc.id,
      summary: existing
        ? `MRP ${doc.noDokumen} menggantikan ${existing.noDokumen} (${doc.summary.shortageCount} kekurangan)`
        : `MRP ${doc.noDokumen} dibuat ulang dari ${plan.noDokumen}`,
      ...auditActor(auth),
    });
    return ok({
      mode: decision.mode,
      mrp: projectMrp(doc as unknown as Record<string, unknown>),
      supersededId: decision.mode === 'supersede' ? existing?.id : undefined,
      supersededNo: decision.mode === 'supersede' ? existing?.noDokumen : undefined,
      acuanApplied: Boolean(built.acuanByKategori),
    });
  }

  if (path[0] === 'material-requirements' && path[1] && !path[2] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('Kebutuhan bahan tidak ditemukan', 404);
    return ok(projectMrp(existing as Record<string, unknown>));
  }

  // POST /material-requirements/:id/recalculate
  if (path[0] === 'material-requirements' && path[1] && path[2] === 'recalculate' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: mrpBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as MaterialRequirementDoc | null;
    if (!existing) return err('Kebutuhan bahan tidak ditemukan', 404);
    if (!isMrpEditable(existing.status)) {
      return err(`Status ${existing.status} tidak dapat dihitung ulang`, 400);
    }

    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: existing.productionPlanId }),
    ) as ProductionPlanDoc | null;
    if (!plan) return err('Rencana produksi tidak ditemukan', 404);

    const built = await buildExplosion(db, scopeAuth, plan);
    if ('error' in built && built.error) return err(built.error, 400);

    const actor = actorFields(auth);
    const now = new Date();
    const acuanNote = built.acuanByKategori
      ? 'dengan acuan porsi tanggal/dapur'
      : 'tanpa acuan porsi (pecah proporsional)';
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: existing.status,
      userId: actor.userId,
      userName: actor.userName,
      note: `Dihitung ulang ${acuanNote}`,
    });

    await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      {
        $set: {
          lines: built.lines,
          summary: built.summary,
          warehouseKode: built.warehouseKode,
          tanggal: cookDateFromPlanTanggal(plan.tanggal),
          kitchenId: plan.kitchenId,
          kitchenNama: plan.kitchenNama,
          productionPlanNo: plan.noDokumen,
          acuanByKategori: built.acuanByKategori ?? null,
          history,
          updatedAt: now,
        },
      },
    );
    const saved = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'MRP_RECALCULATE',
      entityType: 'material_requirement',
      entityId: id,
      summary: `MRP ${existing.noDokumen} dihitung ulang`,
      ...auditActor(auth),
    });
    return ok(projectMrp(saved as Record<string, unknown>));
  }

  if (path[0] === 'material-requirements' && path[1] && path[2] === 'status' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: mrpBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const toStatus = String(mrpBody.status || '').trim() as MaterialRequirementStatus;
    if (!toStatus || !KNOWN_STATUSES.has(toStatus)) return err('status tidak valid', 400);

    const existing = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as MaterialRequirementDoc | null;
    if (!existing) return err('Kebutuhan bahan tidak ditemukan', 404);

    const transitionErr = assertStatusTransition(existing.status, toStatus);
    if (transitionErr) return err(transitionErr, 400);

    const actor = actorFields(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: toStatus as FpDocStatus,
      userId: actor.userId,
      userName: actor.userName,
      note: String(mrpBody.note || '').trim() || undefined,
    });

    await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { status: toStatus, history, updatedAt: now } },
    );
    const saved = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'MRP_STATUS',
      entityType: 'material_requirement',
      entityId: id,
      summary: `MRP ${existing.noDokumen}: ${existing.status} → ${toStatus}`,
      ...auditActor(auth),
    });
    return ok(projectMrp(saved as Record<string, unknown>));
  }

  if (path[0] === 'material-requirements' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as MaterialRequirementDoc | null;
    if (!existing) return err('Kebutuhan bahan tidak ditemukan', 404);
    if (existing.status === 'CANCELLED') return ok({ id, status: 'CANCELLED' });
    if (existing.status === 'COMPLETED') {
      return err('Dokumen selesai tidak dapat dibatalkan', 400);
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
    await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { status: 'CANCELLED', history, updatedAt: now } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'MRP_CANCEL',
      entityType: 'material_requirement',
      entityId: id,
      summary: `MRP ${existing.noDokumen} dibatalkan`,
      ...auditActor(auth),
    });
    return ok({ id, status: 'CANCELLED' });
  }

  return null;
}
