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
  isIsoDate,
  normalizeKategoriPorsiList,
  totalTargetPorsi,
  type ProductionPlanDoc,
  type ProductionPlanLine,
  type ProductionPlanStatus,
} from '@/lib/food-production/production-plan';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import { MENUS_COLLECTION } from '@/lib/food-production/menu';
import { RECIPES_COLLECTION } from '@/lib/food-production/recipe';
import {
  FP_DOC_TYPES,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  type DocHistoryEntry,
  type FpDocStatus,
} from '@/lib/food-production/document';
import { nextFpDocNumber } from '@/lib/food-production/document-number';
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
import { buildPlanMaterialExplosion } from '@/lib/api/handlers/material-requirements';
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
    if (!isPlanEditable(existing.status)) {
      return err(`Qty kebutuhan hanya dapat diubah saat Draft/Diajukan (status: ${existing.status})`, 400);
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
        const readiness = await buildPlanMaterialExplosion(db, scopeAuth, existing);
        if ('error' in readiness && readiness.error) return err(readiness.error, 400);
        const shortageCount = Number(readiness.summary?.shortageCount || 0);
        if (shortageCount > 0) {
          return err(
            `Tidak bisa mulai proses — masih kurang ${shortageCount} item bahan. Buat PO ke Vendor atau lengkapi stok dulu.`,
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

    const built = await buildPlanMaterialExplosion(db, scopeAuth, plan);
    if ('error' in built && built.error) return err(built.error, 400);

    const shortageCount = Number(built.summary?.shortageCount || 0);
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
    const shortageLines = (built.lines || [])
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
      }));

    return ok({
      productionPlanId: id,
      productionPlanNo: plan.noDokumen,
      materialsReady,
      shortageCount: issueCompleted ? 0 : shortageCount,
      lineCount: Number(built.summary?.lineCount || 0),
      warehouseKode: built.warehouseKode,
      shortageLines: issueCompleted ? [] : shortageLines,
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
