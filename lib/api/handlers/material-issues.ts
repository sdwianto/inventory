import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import type { ClientSession } from 'mongodb';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { guardPosting } from '@/lib/api/period-lock';
import { postStockMutation } from '@/lib/api/stock-mutation';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import {
  MATERIAL_ISSUES_COLLECTION,
  ISSUE_ELIGIBLE_PLAN_STATUSES,
  ISSUE_OPEN_STATUSES,
  ISSUE_STATUS_TRANSITIONS,
  isIssueEditable,
  buildIssueLinesFromMrp,
  summarizeIssueLines,
  normalizeIssueLines,
  postingDateFromIso,
  type MaterialIssueDoc,
  type MaterialIssueStatus,
} from '@/lib/food-production/material-issue';
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
  explodeMaterialRequirements,
  type MaterialRequirementDoc,
} from '@/lib/food-production/material-requirement';
import {
  PRODUCTION_PLANS_COLLECTION,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import { MENUS_COLLECTION, type MenuDoc } from '@/lib/food-production/menu';
import { RECIPES_COLLECTION, type RecipeDoc } from '@/lib/food-production/recipe';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import { getStokByWarehouseBatch } from '@/lib/api/stok-lokasi';
import {
  FP_DOC_TYPES,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  nextFpDocNumber,
  type DocHistoryEntry,
  type FpDocStatus,
} from '@/lib/food-production/document';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;
const KNOWN_STATUSES = new Set<string>(Object.keys(FP_DEFAULT_TRANSITIONS));

interface IssueBody extends Record<string, unknown> {
  productionPlanId?: string;
  materialRequirementId?: string;
  lines?: unknown;
  catatan?: string;
  status?: string;
  note?: string;
}

function actorFields(auth: HandlerContext['auth']) {
  return auditActor(auth);
}

function project(doc: Record<string, unknown> | null) {
  if (!doc) return null;
  return clean(doc);
}

function isDuplicateKeyError(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as { code?: number }).code === 11000);
}

async function resolveWarehouse(
  db: HandlerContext['db'],
  scopeAuth: HandlerContext['auth'],
  plan: ProductionPlanDoc,
): Promise<string | { error: string }> {
  let warehouseKode = String(plan.kitchenWarehouseKode || '').trim();
  if (!warehouseKode) {
    const kitchen = await db.collection(KITCHENS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: plan.kitchenId }),
    ) as { defaultWarehouseKode?: string } | null;
    warehouseKode = String(kitchen?.defaultWarehouseKode || '').trim();
  }
  if (!warehouseKode) return { error: 'Dapur belum punya gudang default' };
  return warehouseKode;
}

async function seedLinesFromPlan(
  db: HandlerContext['db'],
  scopeAuth: HandlerContext['auth'],
  plan: ProductionPlanDoc,
  materialRequirementId?: string,
): Promise<
  | { error: string }
  | {
      lines: MaterialIssueDoc['lines'];
      materialRequirementId?: string;
      materialRequirementNo?: string;
      warehouseKode: string;
    }
> {
  const warehouseKode = await resolveWarehouse(db, scopeAuth, plan);
  if (typeof warehouseKode !== 'string') return warehouseKode;

  if (materialRequirementId) {
    const mrp = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: materialRequirementId }),
    ) as MaterialRequirementDoc | null;
    if (!mrp) return { error: 'Kebutuhan bahan tidak ditemukan' };
    if (mrp.productionPlanId !== plan.id) {
      return { error: 'MRP tidak cocok dengan rencana produksi' };
    }
    const lines = buildIssueLinesFromMrp(mrp.lines || []);
    if (!lines.length) return { error: 'MRP tidak punya qty bahan (qtyGross)' };
    return {
      lines,
      materialRequirementId: mrp.id,
      materialRequirementNo: mrp.noDokumen,
      warehouseKode,
    };
  }

  // Latest APPROVED MRP for plan, else explode
  const mrp = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, {
      productionPlanId: plan.id,
      status: { $in: ['APPROVED', 'PROCESSING', 'COMPLETED'] },
    }),
    { sort: { createdAt: -1 } },
  ) as MaterialRequirementDoc | null;
  if (mrp?.lines?.length) {
    const lines = buildIssueLinesFromMrp(mrp.lines);
    if (lines.length) {
      return {
        lines,
        materialRequirementId: mrp.id,
        materialRequirementNo: mrp.noDokumen,
        warehouseKode,
      };
    }
  }

  const tenantFilter = withTenantFilter(scopeAuth, {});
  const menuIds = [...new Set((plan.lines || []).map((l) => l.menuId))];
  const menus = await db.collection(MENUS_COLLECTION)
    .find({ ...tenantFilter, id: { $in: menuIds } })
    .toArray() as unknown as MenuDoc[];
  if (menus.length !== menuIds.length) return { error: 'Menu rencana tidak lengkap' };
  const recipesIds = [...new Set(menus.flatMap((m) => (m.items || []).map((i) => i.recipeId)))];
  const recipes = await db.collection(RECIPES_COLLECTION)
    .find({ ...tenantFilter, id: { $in: recipesIds } })
    .toArray() as unknown as RecipeDoc[];
  const productIds = [...new Set(recipes.flatMap((r) => (r.lines || []).map((l) => l.productId)))];
  const tid = tenantIdForWrite(scopeAuth, {});
  const stockMap = await getStokByWarehouseBatch(db, tid, productIds);
  const onHandByProduct = new Map<string, number>();
  for (const pid of productIds) {
    onHandByProduct.set(pid, Number((stockMap.get(pid) || {})[warehouseKode] || 0));
  }
  const exploded = explodeMaterialRequirements({
    plan,
    menusById: new Map(menus.map((m) => [m.id, m])),
    recipesById: new Map(recipes.map((r) => [r.id, r])),
    onHandByProduct,
    warehouseKode,
  });
  if (!exploded.ok) return { error: exploded.error };
  const lines = buildIssueLinesFromMrp(exploded.lines);
  if (!lines.length) return { error: 'Tidak ada bahan dari rencana' };
  return { lines, warehouseKode };
}

async function assertIssueProductsActive(
  db: HandlerContext['db'],
  tenantId: string,
  lines: MaterialIssueDoc['lines'],
): Promise<string | null> {
  const ids = [...new Set(lines.map((l) => l.productId).filter(Boolean))];
  if (!ids.length) return 'Tidak ada baris bahan';
  const products = await db.collection('products')
    .find({ tenantId, id: { $in: ids } })
    .project({ id: 1, nama: 1, kode: 1, aktif: 1 })
    .toArray();
  const byId = new Map(products.map((p) => [String(p.id), p]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) return `Produk ${id} tidak ditemukan`;
    if (p.aktif === false) {
      return `Produk "${String(p.nama || p.kode || id)}" tidak aktif`;
    }
  }
  return null;
}

async function postIssueStock(
  db: HandlerContext['db'],
  doc: MaterialIssueDoc,
  session?: ClientSession,
): Promise<{ error: string } | { ok: true }> {
  if (!session) {
    return {
      error: 'Posting stok Issue membutuhkan transaksi MongoDB (replica set). Jalankan mongod --replSet rs0',
    };
  }
  for (const line of doc.lines) {
    if (!(Number(line.qtyIssued) > 0)) continue;
    const posted = await postStockMutation(db, {
      tenantId: doc.tenantId,
      productId: line.productId,
      warehouseKode: doc.warehouseKode,
      deltaQtyBase: -Number(line.qtyIssued),
      sourceType: 'FP_ISSUE',
      noTransaksi: doc.noDokumen,
      keterangan: `Pengambilan bahan ${doc.noDokumen} — ${line.productNama || line.productKode || line.productId}`,
      satuan: line.satuan,
      qtyEntered: Number(line.qtyIssued),
      session,
    });
    if (!posted.ok) {
      return { error: posted.error || `Gagal post stok ${line.productId}` };
    }
  }
  return { ok: true };
}

async function bumpPlanProcessing(
  db: HandlerContext['db'],
  scopeAuth: HandlerContext['auth'],
  planId: string,
  session?: ClientSession,
  issueNo?: string,
) {
  const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { id: planId, status: 'APPROVED' }),
    txOpts(session),
  ) as { history?: DocHistoryEntry[] } | null;
  if (!plan) return;
  const now = new Date();
  const history = appendDocHistory(plan.history, {
    at: now,
    fromStatus: 'APPROVED',
    toStatus: 'PROCESSING',
    note: issueNo
      ? `Otomatis dari pengambilan bahan ${issueNo} selesai`
      : 'Otomatis dari pengambilan bahan selesai',
  });
  await db.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
    withTenantFilter(scopeAuth, { id: planId, status: 'APPROVED' }),
    { $set: { status: 'PROCESSING', history, updatedAt: now } },
    txOpts(session),
  );
}

export async function handleMaterialIssues(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const issueBody = (body || {}) as IssueBody;

  if (route === '/material-issues' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const filter: Record<string, unknown> = {};
    const status = (url.searchParams.get('status') || '').trim();
    const tanggal = url.searchParams.get('tanggal');
    const productionPlanId = url.searchParams.get('productionPlanId');
    const kitchenId = resolveKitchenIdFilter(url, request);
    if (status) {
      if (!KNOWN_STATUSES.has(status)) return err('Filter status tidak valid', 400);
      filter.status = status;
    }
    if (tanggal) filter.tanggal = tanggal;
    if (productionPlanId) filter.productionPlanId = productionPlanId;
    if (kitchenId) filter.kitchenId = kitchenId;
    const list = await db.collection(MATERIAL_ISSUES_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => project(d as Record<string, unknown>)));
  }

  if (route === '/material-issues' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: issueBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const productionPlanId = String(issueBody.productionPlanId || '').trim();
    if (!productionPlanId) return err('productionPlanId wajib');

    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: productionPlanId }),
    ) as ProductionPlanDoc | null;
    if (!plan) return err('Rencana produksi tidak ditemukan', 404);
    if (!ISSUE_ELIGIBLE_PLAN_STATUSES.has(plan.status)) {
      return err(`Rencana status ${plan.status} belum siap (wajib Disetujui/Diproses)`, 400);
    }

    const open = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, {
        productionPlanId,
        status: { $in: [...ISSUE_OPEN_STATUSES] },
      }),
    );
    if (open) {
      return err(
        `Sudah ada pengambilan terbuka ${String((open as { noDokumen?: string }).noDokumen || open.id)}`,
        400,
      );
    }

    const seeded = await seedLinesFromPlan(
      db,
      scopeAuth,
      plan,
      String(issueBody.materialRequirementId || '').trim() || undefined,
    );
    if ('error' in seeded) return err(seeded.error, 400);

    let lines = seeded.lines;
    if (issueBody.lines != null) {
      const normalized = normalizeIssueLines(issueBody.lines);
      if ('error' in normalized) return err(normalized.error, 400);
      lines = normalized;
    }

    const tenantId = tenantIdForWrite(scopeAuth, issueBody);
    const productErr = await assertIssueProductsActive(db, tenantId, lines);
    if (productErr) return err(productErr, 400);
    const now = new Date();
    const actor = actorFields(auth);
    const noDokumen = await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.MATERIAL_ISSUE);
    const history: DocHistoryEntry[] = appendDocHistory([], {
      at: now,
      fromStatus: null,
      toStatus: 'DRAFT',
      userId: actor.userId,
      userName: actor.userName,
      note: `Dari rencana ${plan.noDokumen}`,
    });

    const doc: MaterialIssueDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen,
      productionPlanId: plan.id,
      productionPlanNo: plan.noDokumen,
      materialRequirementId: seeded.materialRequirementId,
      materialRequirementNo: seeded.materialRequirementNo,
      tanggal: plan.tanggal,
      kitchenId: plan.kitchenId,
      kitchenNama: plan.kitchenNama,
      warehouseKode: seeded.warehouseKode,
      lines,
      status: 'DRAFT',
      history,
      summary: summarizeIssueLines(lines),
      catatan: String(issueBody.catatan || '').trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };

    try {
      await db.collection(MATERIAL_ISSUES_COLLECTION).insertOne(doc);
    } catch (e) {
      if (isDuplicateKeyError(e)) {
        return err('Pengambilan untuk rencana ini sedang dibuat — muat ulang', 409);
      }
      throw e;
    }

    await writeAuditLog(db, {
      tenantId,
      action: 'ISSUE_CREATE',
      entityType: 'material_issue',
      entityId: doc.id,
      summary: `Issue ${doc.noDokumen} dari ${plan.noDokumen} (${doc.summary.lineCount} item)`,
      ...auditActor(auth),
    });
    return ok(project(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'material-issues' && path[1] && !path[2] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('Pengambilan bahan tidak ditemukan', 404);
    return ok(project(existing as Record<string, unknown>));
  }

  if (path[0] === 'material-issues' && path[1] && !path[2] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: issueBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaterialIssueDoc | null;
    if (!existing) return err('Pengambilan bahan tidak ditemukan', 404);
    if (!isIssueEditable(existing.status)) {
      return err(`Status ${existing.status} tidak dapat diedit`, 400);
    }
    const normalized = normalizeIssueLines(issueBody.lines != null ? issueBody.lines : existing.lines);
    if ('error' in normalized) return err(normalized.error, 400);
    const productErr = await assertIssueProductsActive(db, existing.tenantId, normalized);
    if (productErr) return err(productErr, 400);
    const now = new Date();
    await db.collection(MATERIAL_ISSUES_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      {
        $set: {
          lines: normalized,
          summary: summarizeIssueLines(normalized),
          catatan: issueBody.catatan != null
            ? String(issueBody.catatan).trim() || undefined
            : existing.catatan,
          updatedAt: now,
        },
      },
    );
    const saved = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    return ok(project(saved as Record<string, unknown>));
  }

  if (path[0] === 'material-issues' && path[1] && path[2] === 'status' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: issueBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const toStatus = String(issueBody.status || '').trim() as MaterialIssueStatus;
    if (!toStatus || !KNOWN_STATUSES.has(toStatus)) return err('status tidak valid', 400);

    const existing = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as MaterialIssueDoc | null;
    if (!existing) return err('Pengambilan bahan tidak ditemukan', 404);
    if (existing.status === toStatus) {
      return ok(project(existing as unknown as Record<string, unknown>));
    }
    const transitionErr = assertStatusTransition(existing.status, toStatus, ISSUE_STATUS_TRANSITIONS);
    if (transitionErr) return err(transitionErr, 400);

    const actor = actorFields(auth);
    const now = new Date();

    if (toStatus === 'COMPLETED') {
      if (existing.stockPostedAt) return err('Stok sudah diposting', 400);
      const productErr = await assertIssueProductsActive(db, existing.tenantId, existing.lines);
      if (productErr) return err(productErr, 400);
      const locked = await guardPosting(
        db,
        scopeAuth,
        issueBody,
        postingDateFromIso(existing.tanggal),
      );
      if (locked) return locked;

      try {
        await runInTransactionOrFallback(async ({ db: txDb, session }) => {
          if (!session) {
            throw Object.assign(
              new Error('Posting stok Issue membutuhkan transaksi MongoDB (replica set)'),
              { httpStatus: 503 },
            );
          }
          const fresh = await txDb.collection(MATERIAL_ISSUES_COLLECTION).findOne(
            withTenantFilter(scopeAuth, { id, status: existing.status }),
            txOpts(session),
          ) as MaterialIssueDoc | null;
          if (!fresh) throw Object.assign(new Error('Dokumen berubah'), { httpStatus: 409 });

          // Re-check inside tx (TOCTOU): produk bisa dinonaktifkan antara precheck dan post.
          const productErrTx = await assertIssueProductsActive(txDb, fresh.tenantId, fresh.lines);
          if (productErrTx) {
            throw Object.assign(new Error(productErrTx), { httpStatus: 400 });
          }

          const posted = await postIssueStock(txDb, fresh, session);
          if ('error' in posted) {
            throw Object.assign(new Error(posted.error), { httpStatus: 400 });
          }

          const history = appendDocHistory(fresh.history, {
            at: now,
            fromStatus: fresh.status,
            toStatus: 'COMPLETED',
            userId: actor.userId,
            userName: actor.userName,
            note: String(issueBody.note || '').trim() || 'Stok keluar diposting',
          });
          await txDb.collection(MATERIAL_ISSUES_COLLECTION).updateOne(
            withTenantFilter(scopeAuth, { id }),
            {
              $set: {
                status: 'COMPLETED',
                history,
                stockPostedAt: now,
                updatedAt: now,
              },
            },
            txOpts(session),
          );
          await bumpPlanProcessing(
            txDb,
            scopeAuth,
            fresh.productionPlanId,
            session,
            fresh.noDokumen,
          );
        });
      } catch (e) {
        if (e && typeof e === 'object' && (e as { httpStatus?: number }).httpStatus === 400) {
          return err(e instanceof Error ? e.message : 'Gagal selesaikan', 400);
        }
        if (e && typeof e === 'object' && (e as { httpStatus?: number }).httpStatus === 409) {
          return err('Dokumen berubah — muat ulang', 409);
        }
        if (e && typeof e === 'object' && (e as { httpStatus?: number }).httpStatus === 503) {
          return err(e instanceof Error ? e.message : 'Transaksi MongoDB wajib', 503);
        }
        throw e;
      }

      const saved = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id }),
      );
      await writeAuditLog(db, {
        tenantId: existing.tenantId,
        action: 'ISSUE_COMPLETE',
        entityType: 'material_issue',
        entityId: id,
        summary: `Issue ${existing.noDokumen} selesai — stok keluar`,
        ...auditActor(auth),
      });
      return ok(project(saved as Record<string, unknown>));
    }

    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: toStatus as FpDocStatus,
      userId: actor.userId,
      userName: actor.userName,
      note: String(issueBody.note || '').trim() || undefined,
    });
    await db.collection(MATERIAL_ISSUES_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { status: toStatus, history, updatedAt: now } },
    );
    const saved = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'ISSUE_STATUS',
      entityType: 'material_issue',
      entityId: id,
      summary: `Issue ${existing.noDokumen}: ${existing.status} → ${toStatus}`,
      ...auditActor(auth),
    });
    return ok(project(saved as Record<string, unknown>));
  }

  if (path[0] === 'material-issues' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaterialIssueDoc | null;
    if (!existing) return err('Pengambilan bahan tidak ditemukan', 404);
    if (existing.status === 'CANCELLED') return ok({ id: path[1], status: 'CANCELLED' });
    if (existing.status === 'COMPLETED') {
      return err('Dokumen selesai tidak dapat dibatalkan (stok sudah keluar)', 400);
    }
    const transitionErr = assertStatusTransition(existing.status, 'CANCELLED', ISSUE_STATUS_TRANSITIONS);
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
    await db.collection(MATERIAL_ISSUES_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      { $set: { status: 'CANCELLED', history, updatedAt: now } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'ISSUE_CANCEL',
      entityType: 'material_issue',
      entityId: path[1],
      summary: `Issue ${existing.noDokumen} dibatalkan`,
      ...auditActor(auth),
    });
    return ok({ id: path[1], status: 'CANCELLED' });
  }

  return null;
}
