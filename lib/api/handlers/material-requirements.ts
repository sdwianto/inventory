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
  MRP_ELIGIBLE_PLAN_STATUSES,
  type MaterialRequirementDoc,
  type MaterialRequirementStatus,
} from '@/lib/food-production/material-requirement';
import {
  PRODUCTION_PLANS_COLLECTION,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import { MENUS_COLLECTION, type MenuDoc } from '@/lib/food-production/menu';
import { RECIPES_COLLECTION, type RecipeDoc } from '@/lib/food-production/recipe';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import { getStokByWarehouseBatch } from '@/lib/api/stok-lokasi';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import {
  FP_DOC_TYPES,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  nextFpDocNumber,
  type DocHistoryEntry,
  type FpDocStatus,
} from '@/lib/food-production/document';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;
const KNOWN_STATUSES = new Set<string>(Object.keys(FP_DEFAULT_TRANSITIONS));

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

  const menuIds = [...new Set((plan.lines || []).map((l) => l.menuId))];
  const menus = await db.collection(MENUS_COLLECTION)
    .find({ ...tenantFilter, id: { $in: menuIds } })
    .toArray() as unknown as MenuDoc[];
  if (menus.length !== menuIds.length) {
    const found = new Set(menus.map((m) => m.id));
    const missing = menuIds.find((id) => !found.has(id));
    return { error: `Menu ${missing} tidak ditemukan` as const };
  }
  const menusById = new Map(menus.map((m) => [m.id, m]));

  const recipeIds = [...new Set(
    menus.flatMap((m) => (m.items || []).map((i) => i.recipeId)),
  )];
  const recipes = await db.collection(RECIPES_COLLECTION)
    .find({ ...tenantFilter, id: { $in: recipeIds } })
    .toArray() as unknown as RecipeDoc[];
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

  const exploded = explodeMaterialRequirements({
    plan,
    menusById,
    recipesById,
    onHandByProduct,
    warehouseKode,
  });
  if (!exploded.ok) return { error: exploded.error };
  const lines = exploded.lines.map((l) => ({
    ...l,
    stockWarehouseKode: stockWarehouseByProduct.get(l.productId) || warehouseKode,
  }));
  return { warehouseKode, lines, summary: exploded.summary };
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
      tanggal: plan.tanggal,
      kitchenId: plan.kitchenId,
      kitchenNama: plan.kitchenNama,
      warehouseKode: built.warehouseKode!,
      lines: built.lines!,
      status: 'DRAFT',
      history,
      summary: built.summary!,
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
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: existing.status,
      userId: actor.userId,
      userName: actor.userName,
      note: 'Dihitung ulang',
    });

    await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      {
        $set: {
          lines: built.lines,
          summary: built.summary,
          warehouseKode: built.warehouseKode,
          tanggal: plan.tanggal,
          kitchenId: plan.kitchenId,
          kitchenNama: plan.kitchenNama,
          productionPlanNo: plan.noDokumen,
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
