/**
 * Weekly menu plans — GET get-or-empty, PUT upsert draft, POST :id/publish → RPN.
 */

import type { NextResponse } from 'next/server';
import type { ClientSession } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import {
  WEEKLY_MENU_PLANS_COLLECTION,
  assertWeekStart,
  buildPublishPlanLines,
  emptyWeeklyDays,
  isoWeekdays,
  lockedDayEditError,
  normalizeWeeklyDays,
  presentWeeklyMenuDays,
  rpnPublishBlockedReason,
  selectPublishTargetPlan,
  weeklyPlanStatusFromDays,
  type WeeklyMenuDay,
  type WeeklyMenuPlanDoc,
  type WeeklyRecipeRef,
} from '@/lib/food-production/weekly-menu-plan';
import {
  PRODUCTION_PLANS_COLLECTION,
  isIsoDate,
  normalizePlanLines,
  type ProductionPlanDoc,
  type ProductionPlanLine,
} from '@/lib/food-production/production-plan';
import {
  PORTION_TARGETS_COLLECTION,
  type PortionTargetDoc,
} from '@/lib/food-production/portion-target';
import { RECIPES_COLLECTION } from '@/lib/food-production/recipe';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import { FP_MANAGE_ROLES } from '@/lib/food-production/roles';
import { FP_DOC_TYPES, appendDocHistory, type DocHistoryEntry } from '@/lib/food-production/document';
import { nextFpDocNumber } from '@/lib/food-production/document-number';
import type { HandlerContext } from '@/types/api/handler';

interface WeeklyBody extends Record<string, unknown> {
  kitchenId?: string;
  weekStart?: string;
  days?: unknown;
  tanggal?: string;
}

function projectWeekly(doc: Record<string, unknown> | null) {
  if (!doc) return null;
  return clean(doc);
}

function presentWeeklyPayload(doc: WeeklyMenuPlanDoc | Record<string, unknown>) {
  const weekStart = String(doc.weekStart || '');
  const days = presentWeeklyMenuDays(doc.days as WeeklyMenuDay[], weekStart);
  return {
    ...projectWeekly({ ...doc, days } as Record<string, unknown>),
    exists: true,
  };
}

function emptyPayload(kitchenId: string, weekStart: string, kitchenNama?: string) {
  return {
    exists: false,
    kitchenId,
    kitchenNama,
    weekStart,
    status: 'DRAFT',
    days: emptyWeeklyDays(weekStart),
  };
}

async function loadKitchen(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
  kitchenId: string,
  requireActive = true,
): Promise<{ nama: string; warehouseKode?: string } | { error: string }> {
  const doc = await db.collection(KITCHENS_COLLECTION).findOne({
    ...tenantFilter,
    id: kitchenId,
  }) as { nama?: string; aktif?: boolean; defaultWarehouseKode?: string } | null;
  if (!doc) return { error: 'Dapur tidak ditemukan' };
  if (requireActive && doc.aktif === false) return { error: 'Dapur nonaktif' };
  return {
    nama: String(doc.nama || kitchenId),
    warehouseKode: doc.defaultWarehouseKode ? String(doc.defaultWarehouseKode) : undefined,
  };
}

async function loadRecipesByIds(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
  ids: string[],
): Promise<Map<string, WeeklyRecipeRef>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await db.collection(RECIPES_COLLECTION)
    .find({ ...tenantFilter, id: { $in: unique } })
    .project({ id: 1, kode: 1, nama: 1, aktif: 1, kategoriMenu: 1, lines: 1 })
    .toArray();
  return new Map(rows.map((r) => [String(r.id), {
    id: String(r.id),
    kode: r.kode != null ? String(r.kode) : undefined,
    nama: r.nama != null ? String(r.nama) : undefined,
    aktif: r.aktif !== false,
    kategoriMenu: r.kategoriMenu != null ? String(r.kategoriMenu) : null,
    lines: Array.isArray(r.lines) ? r.lines : [],
  }]));
}

async function upsertPortionTargets(
  db: HandlerContext['db'],
  scopeAuth: HandlerContext['auth'],
  input: {
    tenantId: string;
    kitchenId: string;
    kitchenNama?: string;
    tanggal: string;
    targets: PortionTargetDoc['targets'];
  },
  session?: ClientSession,
) {
  const now = new Date();
  const actor = auditActor(scopeAuth);
  const opts = txOpts(session);
  const existing = await db.collection(PORTION_TARGETS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { tanggal: input.tanggal, kitchenId: input.kitchenId }),
    opts,
  ) as PortionTargetDoc | null;
  if (existing) {
    await db.collection(PORTION_TARGETS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: existing.id }),
      {
        $set: {
          targets: input.targets,
          kitchenNama: input.kitchenNama,
          updatedAt: now,
          updatedBy: actor.userId,
          updatedByName: actor.userName,
        },
      },
      opts,
    );
    return;
  }
  const doc: PortionTargetDoc = {
    id: uuidv4(),
    tenantId: input.tenantId,
    tanggal: input.tanggal,
    kitchenId: input.kitchenId,
    kitchenNama: input.kitchenNama,
    targets: input.targets,
    createdAt: now,
    updatedAt: now,
    updatedBy: actor.userId,
    updatedByName: actor.userName,
  };
  await db.collection(PORTION_TARGETS_COLLECTION).insertOne(doc, opts);
}

async function loadRpnStatusByIds(
  db: HandlerContext['db'],
  scopeAuth: HandlerContext['auth'],
  ids: string[],
): Promise<Map<string, { status?: string; noDokumen?: string }>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await db.collection(PRODUCTION_PLANS_COLLECTION)
    .find(withTenantFilter(scopeAuth, { id: { $in: unique } }))
    .project({ id: 1, status: 1, noDokumen: 1 })
    .toArray() as Array<{ id: string; status?: string; noDokumen?: string }>;
  return new Map(rows.map((r) => [String(r.id), {
    status: r.status,
    noDokumen: r.noDokumen,
  }]));
}

async function findPublishTargetPlan(
  db: HandlerContext['db'],
  scopeAuth: HandlerContext['auth'],
  input: {
    weeklyMenuPlanId: string;
    kitchenId: string;
    tanggal: string;
    linkedId?: string;
  },
): Promise<ProductionPlanDoc | null | { error: string }> {
  const load = async (id: string) => db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { id }),
  ) as Promise<ProductionPlanDoc | null>;

  if (input.linkedId) {
    const linked = await load(input.linkedId);
    if (linked) {
      const blocked = rpnPublishBlockedReason(linked.status);
      if (blocked) return { error: `${input.tanggal}: ${blocked} (${linked.noDokumen})` };
      if (String(linked.status || '').trim() !== 'CANCELLED') return linked;
    }
  }

  const same = await db.collection(PRODUCTION_PLANS_COLLECTION)
    .find(withTenantFilter(scopeAuth, {
      kitchenId: input.kitchenId,
      tanggal: input.tanggal,
      status: { $ne: 'CANCELLED' },
    }))
    .sort({ updatedAt: -1 })
    .limit(10)
    .toArray() as unknown as ProductionPlanDoc[];

  const picked = selectPublishTargetPlan(same, input.weeklyMenuPlanId);
  if ('error' in picked) return { error: `${input.tanggal}: ${picked.error}` };
  return picked.plan;
}

export async function handleWeeklyMenuPlans(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  if (!route.startsWith('/weekly-menu-plans')) return null;
  const weeklyBody = (body || {}) as WeeklyBody;

  if (route === '/weekly-menu-plans' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const weekStartRaw = assertWeekStart(url.searchParams.get('weekStart') || '');
    if (typeof weekStartRaw !== 'string') return err(weekStartRaw.error, 400);
    const kitchenId = resolveKitchenIdFilter(url, request)
      || String(url.searchParams.get('kitchenId') || '').trim();
    if (!kitchenId) return err('Dapur wajib dipilih (scope dapur / kitchenId)', 400);

    const existing = await db.collection(WEEKLY_MENU_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { kitchenId, weekStart: weekStartRaw }),
    ) as WeeklyMenuPlanDoc | null;
    if (!existing) {
      const kitchen = await loadKitchen(db, withTenantFilter(scopeAuth, {}), kitchenId, false);
      return ok(emptyPayload(
        kitchenId,
        weekStartRaw,
        'error' in kitchen ? undefined : kitchen.nama,
      ));
    }
    return ok(presentWeeklyPayload(existing as unknown as Record<string, unknown>));
  }

  if (path[0] === 'weekly-menu-plans' && path[1] && !path[2] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(WEEKLY_MENU_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('Rencana menu mingguan tidak ditemukan', 404);
    return ok(presentWeeklyPayload(existing as Record<string, unknown>));
  }

  if (route === '/weekly-menu-plans' && method === 'PUT') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: weeklyBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const weekStart = assertWeekStart(weeklyBody.weekStart);
    if (typeof weekStart !== 'string') return err(weekStart.error, 400);
    const kitchenId = String(weeklyBody.kitchenId || '').trim()
      || resolveKitchenIdFilter(url, request)
      || '';
    if (!kitchenId) return err('Dapur wajib dipilih', 400);

    const tenantFilter = withTenantFilter(scopeAuth, {});
    const kitchen = await loadKitchen(db, tenantFilter, kitchenId, true);
    if ('error' in kitchen) return err(kitchen.error, 400);
    const kitchenNama = kitchen.nama;

    const existing = await db.collection(WEEKLY_MENU_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { kitchenId, weekStart }),
    ) as WeeklyMenuPlanDoc | null;

    const days = normalizeWeeklyDays(weeklyBody.days, weekStart, existing?.days);
    if ('error' in days) return err(days.error, 400);

    if (existing) {
      const rpnById = await loadRpnStatusByIds(
        db,
        scopeAuth,
        existing.days.map((d) => d.productionPlanId || ''),
      );
      const locked = lockedDayEditError(existing.days, days, rpnById);
      if (locked) return err(locked, 409);
    }

    const now = new Date();
    const actor = auditActor(auth);
    const tenantId = tenantIdForWrite(scopeAuth, weeklyBody);
    const status = weeklyPlanStatusFromDays(days);

    async function persistExisting(id: string, nextDays: WeeklyMenuDay[]) {
      await db.collection(WEEKLY_MENU_PLANS_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, { id }),
        {
          $set: {
            days: nextDays,
            status: weeklyPlanStatusFromDays(nextDays),
            kitchenNama,
            updatedAt: now,
            updatedBy: actor.userId,
            updatedByName: actor.userName,
          },
        },
      );
      const saved = await db.collection(WEEKLY_MENU_PLANS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id }),
      ) as WeeklyMenuPlanDoc | null;
      await writeAuditLog(db, {
        tenantId,
        action: 'WEEKLY_MENU_PLAN_UPSERT',
        entityType: 'weekly_menu_plan',
        entityId: id,
        summary: `Rencana menu minggu ${weekStart} disimpan`,
        ...actor,
      });
      if (!saved) return err('Gagal menyimpan rencana menu', 500);
      return ok(presentWeeklyPayload(saved as unknown as Record<string, unknown>));
    }

    if (existing) {
      return persistExisting(existing.id, days);
    }

    const doc: WeeklyMenuPlanDoc = {
      id: uuidv4(),
      tenantId,
      kitchenId,
      kitchenNama,
      weekStart,
      status,
      days,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
      updatedBy: actor.userId,
      updatedByName: actor.userName,
    };
    try {
      await db.collection(WEEKLY_MENU_PLANS_COLLECTION).insertOne(doc);
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        const raced = await db.collection(WEEKLY_MENU_PLANS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { kitchenId, weekStart }),
        ) as WeeklyMenuPlanDoc | null;
        if (!raced) return err('Rencana menu minggu ini sudah ada', 400);
        const days2 = normalizeWeeklyDays(weeklyBody.days, weekStart, raced.days);
        if ('error' in days2) return err(days2.error, 400);
        const rpnById = await loadRpnStatusByIds(
          db,
          scopeAuth,
          raced.days.map((d) => d.productionPlanId || ''),
        );
        const locked = lockedDayEditError(raced.days, days2, rpnById);
        if (locked) return err(locked, 409);
        return persistExisting(raced.id, days2);
      }
      throw e;
    }
    await writeAuditLog(db, {
      tenantId,
      action: 'WEEKLY_MENU_PLAN_UPSERT',
      entityType: 'weekly_menu_plan',
      entityId: doc.id,
      summary: `Rencana menu minggu ${weekStart} dibuat`,
      ...actor,
    });
    return ok(presentWeeklyPayload(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'weekly-menu-plans' && path[1] && path[2] === 'publish' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: weeklyBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(WEEKLY_MENU_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as WeeklyMenuPlanDoc | null;
    if (!existing) return err('Rencana menu mingguan tidak ditemukan', 404);

    const tanggalFilter = String(weeklyBody.tanggal || '').trim();
    if (tanggalFilter && !isIsoDate(tanggalFilter)) {
      return err('Tanggal tidak valid (YYYY-MM-DD)', 400);
    }
    const weekDates = new Set(isoWeekdays(existing.weekStart));
    if (tanggalFilter && !weekDates.has(tanggalFilter)) {
      return err('Tanggal di luar minggu rencana ini', 400);
    }

    const daysToPublish = existing.days.filter((d) => (
      tanggalFilter ? d.tanggal === tanggalFilter : true
    ));
    if (!daysToPublish.length) return err('Tidak ada hari untuk diterbitkan', 400);

    const tenantFilter = withTenantFilter(scopeAuth, {});
    const kitchen = await loadKitchen(db, tenantFilter, existing.kitchenId, true);
    if ('error' in kitchen) return err(kitchen.error, 400);
    const kitchenNama = kitchen.nama;
    const kitchenWarehouseKode = kitchen.warehouseKode;

    const recipeIds = daysToPublish.flatMap((d) => [
      ...Object.values(d.slots || {}).flat(),
      ...(d.alergi || []).map((a) => a.recipeId),
    ]);
    const recipesById = await loadRecipesByIds(db, tenantFilter, recipeIds);

    const actor = auditActor(auth);
    const warnings: string[] = [];

    type PublishJob = {
      day: WeeklyMenuDay;
      built: Exclude<ReturnType<typeof buildPublishPlanLines>, { error: string }>;
      lines: ProductionPlanLine[];
      target: ProductionPlanDoc | null;
    };
    const jobs: PublishJob[] = [];

    for (const day of daysToPublish) {
      const built = buildPublishPlanLines(day, recipesById);
      if ('error' in built) {
        if (tanggalFilter) return err(built.error, 400);
        warnings.push(built.error);
        continue;
      }
      warnings.push(...built.warnings);
      const linesOk = normalizePlanLines(built.lines);
      if ('error' in linesOk) return err(`${day.tanggal}: ${linesOk.error}`, 400);

      const target = await findPublishTargetPlan(db, scopeAuth, {
        weeklyMenuPlanId: existing.id,
        kitchenId: existing.kitchenId,
        tanggal: day.tanggal,
        linkedId: day.productionPlanId,
      });
      if (target && 'error' in target) return err(target.error, 400);
      jobs.push({
        day,
        built,
        lines: linesOk as ProductionPlanLine[],
        target,
      });
    }

    if (!jobs.length) {
      return err(warnings[0] || 'Tidak ada hari yang siap diterbitkan', 400);
    }

    const now = new Date();
    let published: Array<{ tanggal: string; productionPlanId: string; productionPlanNo: string }> = [];
    let nextDays: WeeklyMenuDay[] = existing.days.map((d) => ({ ...d }));

    try {
      const result = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        const outPublished: Array<{ tanggal: string; productionPlanId: string; productionPlanNo: string }> = [];
        const outDays: WeeklyMenuDay[] = existing.days.map((d) => ({ ...d }));
        const opts = txOpts(session);

        for (const job of jobs) {
          await upsertPortionTargets(txDb, scopeAuth, {
            tenantId: existing.tenantId,
            kitchenId: existing.kitchenId,
            kitchenNama,
            tanggal: job.day.tanggal,
            targets: job.day.porsiByKategori,
          }, session);

          let planId: string;
          let planNo: string;
          if (job.target) {
            const history = appendDocHistory(job.target.history || [], {
              at: now,
              fromStatus: job.target.status,
              toStatus: job.target.status,
              userId: actor.userId,
              userName: actor.userName,
              note: 'Diperbarui dari perencanaan menu mingguan',
            } as DocHistoryEntry);
            const updated = await txDb.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
              withTenantFilter(scopeAuth, {
                id: job.target.id,
                status: { $in: ['DRAFT', 'SUBMITTED'] },
              }),
              {
                $set: {
                  lines: job.lines,
                  kategoriPorsi: job.built.kategoriPorsiList[0],
                  kategoriPorsiList: job.built.kategoriPorsiList,
                  recipeBufferPct: job.built.recipeBufferPct,
                  catatan: job.built.catatan || job.target.catatan || null,
                  weeklyMenuPlanId: existing.id,
                  kitchenNama,
                  kitchenWarehouseKode: kitchenWarehouseKode || null,
                  updatedAt: now,
                  history,
                },
              },
              opts,
            );
            if (!updated.matchedCount) {
              throw new Error(
                `${job.day.tanggal}: RPN ${job.target.noDokumen} berubah status — terbit dibatalkan`,
              );
            }
            planId = job.target.id;
            planNo = job.target.noDokumen;
          } else {
            const history: DocHistoryEntry[] = appendDocHistory([], {
              at: now,
              fromStatus: null,
              toStatus: 'DRAFT',
              userId: actor.userId,
              userName: actor.userName,
              note: 'Diterbitkan dari perencanaan menu mingguan',
            });
            const noDokumen = await nextFpDocNumber(
              txDb,
              existing.tenantId,
              FP_DOC_TYPES.PRODUCTION_PLAN,
              session,
            );
            const plan: ProductionPlanDoc = {
              id: uuidv4(),
              tenantId: existing.tenantId,
              noDokumen,
              tanggal: job.day.tanggal,
              kitchenId: existing.kitchenId,
              kitchenNama,
              kitchenWarehouseKode,
              kategoriPorsi: job.built.kategoriPorsiList[0],
              kategoriPorsiList: job.built.kategoriPorsiList,
              lines: job.lines,
              recipeBufferPct: job.built.recipeBufferPct,
              weeklyMenuPlanId: existing.id,
              status: 'DRAFT',
              history,
              catatan: job.built.catatan,
              createdAt: now,
              updatedAt: now,
              createdBy: actor.userId,
              createdByName: actor.userName,
            };
            await txDb.collection(PRODUCTION_PLANS_COLLECTION).insertOne(plan, opts);
            planId = plan.id;
            planNo = plan.noDokumen;
          }

          const idx = outDays.findIndex((d) => d.tanggal === job.day.tanggal);
          if (idx >= 0) {
            outDays[idx] = {
              ...outDays[idx],
              productionPlanId: planId,
              productionPlanNo: planNo,
            };
          }
          outPublished.push({
            tanggal: job.day.tanggal,
            productionPlanId: planId,
            productionPlanNo: planNo,
          });
        }

        await txDb.collection(WEEKLY_MENU_PLANS_COLLECTION).updateOne(
          withTenantFilter(scopeAuth, { id: existing.id }),
          {
            $set: {
              days: outDays,
              status: weeklyPlanStatusFromDays(outDays),
              updatedAt: now,
              updatedBy: actor.userId,
              updatedByName: actor.userName,
            },
          },
          opts,
        );
        return { published: outPublished, days: outDays };
      });
      published = result.published;
      nextDays = result.days;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Gagal menerbitkan rencana menu';
      return err(message, 409);
    }

    const saved = await db.collection(WEEKLY_MENU_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: existing.id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'WEEKLY_MENU_PLAN_PUBLISH',
      entityType: 'weekly_menu_plan',
      entityId: existing.id,
      summary: `Terbit ${published.map((p) => p.productionPlanNo).join(', ')}`,
      ...actor,
    });
    return ok({
      ...presentWeeklyPayload((saved || { ...existing, days: nextDays }) as Record<string, unknown>),
      published,
      warnings: warnings.filter(Boolean),
    });
  }

  return err('Method tidak diizinkan', 405);
}
