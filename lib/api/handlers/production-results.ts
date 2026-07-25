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
  PRODUCTION_RESULTS_COLLECTION,
  RESULT_ELIGIBLE_PLAN_STATUSES,
  RESULT_OPEN_STATUSES,
  RESULT_STATUS_TRANSITIONS,
  isResultEditable,
  buildResultLinesFromPlan,
  summarizeResultLines,
  normalizeResultLines,
  assertResultStockGate,
  assertPlanCanComplete,
  postingDateFromIso,
  resultHasStockableLines,
  resultLineGrossPorsi,
  type ProductionResultDoc,
  type ProductionResultStatus,
} from '@/lib/food-production/production-result';
import { consumeBatchesFefo } from '@/lib/food-production/fefo-consume';
import {
  MATERIAL_ISSUES_COLLECTION,
  ISSUE_OPEN_STATUSES,
  type MaterialIssueDoc,
} from '@/lib/food-production/material-issue';
import {
  PRODUCTION_PLANS_COLLECTION,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import { MENUS_COLLECTION, type MenuDoc } from '@/lib/food-production/menu';
import { RECIPES_COLLECTION, type RecipeDoc } from '@/lib/food-production/recipe';
import { KITCHENS_COLLECTION, type KitchenDoc } from '@/lib/food-production/kitchen';
import {
  FP_DOC_TYPES,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  type DocHistoryEntry,
  type FpDocStatus,
} from '@/lib/food-production/document';
import { nextFpDocNumber } from '@/lib/food-production/document-number';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import {
  PRODUCTION_BATCHES_COLLECTION,
  buildBatchNo,
  defaultExpiryDate,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;
const KNOWN_STATUSES = new Set<string>(Object.keys(FP_DEFAULT_TRANSITIONS));

interface ResultBody extends Record<string, unknown> {
  productionPlanId?: string;
  materialIssueId?: string;
  lines?: unknown;
  catatan?: string;
  status?: string;
  note?: string;
  batchNo?: string;
  expiryDate?: string;
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

async function seedResultLines(
  db: HandlerContext['db'],
  scopeAuth: HandlerContext['auth'],
  plan: ProductionPlanDoc,
): Promise<
  | { error: string }
  | { lines: ProductionResultDoc['lines']; warehouseKode: string; warnings: string[] }
> {
  const warehouseKode = await resolveWarehouse(db, scopeAuth, plan);
  if (typeof warehouseKode !== 'string') return warehouseKode;

  const tenantFilter = withTenantFilter(scopeAuth, {});
  const menuIds = [...new Set(
    (plan.lines || []).map((l) => String(l.menuId || '').trim()).filter(Boolean),
  )];
  const menus = menuIds.length
    ? await db.collection(MENUS_COLLECTION)
      .find({ ...tenantFilter, id: { $in: menuIds } })
      .toArray() as unknown as MenuDoc[]
    : [];
  if (menus.length !== menuIds.length) return { error: 'Menu rencana tidak lengkap' };

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
    return { error: 'Resep rencana tidak lengkap' };
  }

  // Enrich FG names from products
  const fgIds = [...new Set(recipes.map((r) => r.finishedGoodProductId).filter(Boolean))];
  const products = fgIds.length
    ? await db.collection('products')
      .find({ ...tenantFilter, id: { $in: fgIds } })
      .project({ id: 1, kode: 1, nama: 1, satuan: 1, aktif: 1 })
      .toArray()
    : [];
  const prodById = new Map(products.map((p) => [String(p.id), p]));
  for (const r of recipes) {
    const p = prodById.get(String(r.finishedGoodProductId));
    if (!p) continue;
    if (!r.finishedGoodKode && p.kode != null) r.finishedGoodKode = String(p.kode);
    if (!r.finishedGoodNama && p.nama != null) r.finishedGoodNama = String(p.nama);
  }

  const built = buildResultLinesFromPlan({
    planLines: plan.lines || [],
    menusById: new Map(menus.map((m) => [m.id, m])),
    recipesById: new Map(recipes.map((r) => [r.id, r])),
  });
  if (!built.ok) return { error: built.error };

  // Only validate product master for lines that actually have FG (manufaktur).
  for (const line of built.lines) {
    const fgId = String(line.finishedGoodProductId || '').trim();
    if (!fgId) continue;
    const p = prodById.get(fgId);
    if (!p) return { error: `Finished good ${fgId} tidak ditemukan` };
    if (p.aktif === false) {
      return {
        error: `Finished good "${String(p.nama || p.kode || fgId)}" tidak aktif`,
      };
    }
    if (p.satuan) line.satuan = String(p.satuan);
  }

  return { lines: built.lines, warehouseKode, warnings: built.warnings };
}

async function assertResultProductsActive(
  db: HandlerContext['db'],
  tenantId: string,
  lines: ProductionResultDoc['lines'],
): Promise<string | null> {
  const ids = [...new Set(
    lines.map((l) => String(l.finishedGoodProductId || '').trim()).filter(Boolean),
  )];
  if (!ids.length) return null; // MBG: no FG stock products
  const products = await db.collection('products')
    .find({ tenantId, id: { $in: ids } })
    .project({ id: 1, nama: 1, kode: 1, aktif: 1 })
    .toArray();
  const byId = new Map(products.map((p) => [String(p.id), p]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) return `Finished good ${id} tidak ditemukan`;
    if (p.aktif === false) {
      return `Finished good "${String(p.nama || p.kode || id)}" tidak aktif`;
    }
  }
  return null;
}

async function loadIssueGate(
  db: HandlerContext['db'],
  scopeAuth: HandlerContext['auth'],
  planId: string,
  session?: ClientSession,
): Promise<{ hasCompletedIssue: boolean; hasOpenIssue: boolean }> {
  const [completedIssue, openIssue] = await Promise.all([
    db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { productionPlanId: planId, status: 'COMPLETED' }),
      txOpts(session),
    ),
    db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, {
        productionPlanId: planId,
        status: { $in: [...ISSUE_OPEN_STATUSES] },
      }),
      txOpts(session),
    ),
  ]);
  return {
    hasCompletedIssue: Boolean(completedIssue),
    hasOpenIssue: Boolean(openIssue),
  };
}

async function postResultStock(
  db: HandlerContext['db'],
  doc: ProductionResultDoc,
  session?: ClientSession,
): Promise<{ error: string } | { ok: true; postedLines: number; wastePostedQty: number }> {
  let postedLines = 0;
  let wastePostedQty = 0;
  for (const line of doc.lines) {
    const fgId = String(line.finishedGoodProductId || '').trim();
    const waste = Number(line.wastePorsi) || 0;
    const gross = resultLineGrossPorsi(line);
    if (!fgId || !(gross > 0)) continue; // MBG / empty FG — skip stock
    if (!session) {
      return {
        error: 'Posting stok Result membutuhkan transaksi MongoDB (replica set). Jalankan mongod --replSet rs0',
      };
    }
    // W2-15: IN gross (actual + waste), then OUT waste as FP_RESULT_WASTE.
    const posted = await postStockMutation(db, {
      tenantId: doc.tenantId,
      productId: fgId,
      warehouseKode: doc.warehouseKode,
      deltaQtyBase: gross,
      sourceType: 'FP_RESULT',
      noTransaksi: doc.noDokumen,
      keterangan: `Hasil produksi ${doc.noDokumen} — ${line.finishedGoodNama || line.finishedGoodKode || fgId}`,
      satuan: line.satuan,
      qtyEntered: gross,
      session,
    });
    if (!posted.ok) {
      return { error: posted.error || `Gagal post stok ${fgId}` };
    }
    postedLines += 1;

    if (waste > 0) {
      const wasteOut = await postStockMutation(db, {
        tenantId: doc.tenantId,
        productId: fgId,
        warehouseKode: doc.warehouseKode,
        deltaQtyBase: -waste,
        sourceType: 'FP_RESULT_WASTE',
        noTransaksi: doc.noDokumen,
        keterangan: `Write-off waste HSL ${doc.noDokumen} — ${line.finishedGoodNama || line.finishedGoodKode || fgId}`,
        satuan: line.satuan,
        qtyEntered: waste,
        session,
      });
      if (!wasteOut.ok) {
        return { error: wasteOut.error || `Gagal write-off waste ${fgId}` };
      }
      wastePostedQty += waste;
    }
  }
  return { ok: true, postedLines, wastePostedQty };
}

async function maybeCompletePlan(
  db: HandlerContext['db'],
  scopeAuth: HandlerContext['auth'],
  planId: string,
  session?: ClientSession,
) {
  const issueGate = await loadIssueGate(db, scopeAuth, planId, session);
  const openResult = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, {
      productionPlanId: planId,
      status: { $in: [...RESULT_OPEN_STATUSES] },
    }),
    txOpts(session),
  );
  const completedResult = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { productionPlanId: planId, status: 'COMPLETED' }),
    txOpts(session),
  );
  if (!assertPlanCanComplete({
    hasCompletedIssue: issueGate.hasCompletedIssue,
    hasOpenIssue: issueGate.hasOpenIssue,
    hasOpenResult: Boolean(openResult),
    hasCompletedResult: Boolean(completedResult),
  })) {
    return;
  }
  await db.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
    withTenantFilter(scopeAuth, { id: planId, status: { $in: ['APPROVED', 'PROCESSING'] } }),
    { $set: { status: 'COMPLETED', updatedAt: new Date() } },
    txOpts(session),
  );
}

export async function handleProductionResults(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const resultBody = (body || {}) as ResultBody;

  if (route === '/production-results' && method === 'GET') {
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
    const list = await db.collection(PRODUCTION_RESULTS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => project(d as Record<string, unknown>)));
  }

  if (route === '/production-results' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: resultBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const productionPlanId = String(resultBody.productionPlanId || '').trim();
    if (!productionPlanId) return err('productionPlanId wajib');

    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: productionPlanId }),
    ) as ProductionPlanDoc | null;
    if (!plan) return err('Rencana produksi tidak ditemukan', 404);
    if (!RESULT_ELIGIBLE_PLAN_STATUSES.has(plan.status)) {
      return err(`Rencana status ${plan.status} belum siap (wajib Disetujui/Diproses, atau Selesai untuk catch-up)`, 400);
    }

    const open = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, {
        productionPlanId,
        status: { $in: [...RESULT_OPEN_STATUSES] },
      }),
    );
    if (open) {
      return err(
        `Sudah ada hasil terbuka ${String((open as { noDokumen?: string }).noDokumen || open.id)}`,
        400,
      );
    }

    const existingCompleted = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { productionPlanId, status: 'COMPLETED' }),
      { projection: { id: 1, noDokumen: 1 } },
    );
    if (existingCompleted) {
      return err(
        `Hasil ${String(existingCompleted.noDokumen || existingCompleted.id)} sudah selesai untuk rencana ini`,
        400,
      );
    }

    let materialIssueId: string | undefined;
    let materialIssueNo: string | undefined;
    const issueIdHint = String(resultBody.materialIssueId || '').trim();
    if (issueIdHint) {
      const issue = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: issueIdHint }),
      ) as MaterialIssueDoc | null;
      if (!issue) return err('Pengambilan bahan tidak ditemukan', 404);
      if (issue.productionPlanId !== plan.id) return err('Issue tidak cocok dengan rencana', 400);
      materialIssueId = issue.id;
      materialIssueNo = issue.noDokumen;
    } else {
      const completedIssue = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { productionPlanId, status: 'COMPLETED' }),
        { sort: { createdAt: -1 } },
      ) as MaterialIssueDoc | null;
      if (completedIssue) {
        materialIssueId = completedIssue.id;
        materialIssueNo = completedIssue.noDokumen;
      }
    }

    const seeded = await seedResultLines(db, scopeAuth, plan);
    if ('error' in seeded) return err(seeded.error, 400);

    let lines = seeded.lines;
    if (resultBody.lines != null) {
      const normalized = normalizeResultLines(resultBody.lines);
      if ('error' in normalized) return err(normalized.error, 400);
      lines = normalized;
    }

    const productErr = await assertResultProductsActive(
      db,
      tenantIdForWrite(scopeAuth, resultBody),
      lines,
    );
    if (productErr) return err(productErr, 400);

    const summary = summarizeResultLines(lines);
    if (!materialIssueId) {
      summary.warnings = [
        ...(seeded.warnings || []),
        'Belum ada pengambilan bahan (PBL) selesai untuk rencana ini',
      ];
    } else if (seeded.warnings.length) {
      summary.warnings = seeded.warnings;
    }

    const tenantId = tenantIdForWrite(scopeAuth, resultBody);
    const now = new Date();
    const actor = actorFields(auth);
    const noDokumen = await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.PRODUCTION_RESULT);
    const history: DocHistoryEntry[] = appendDocHistory([], {
      at: now,
      fromStatus: null,
      toStatus: 'DRAFT',
      userId: actor.userId,
      userName: actor.userName,
      note: `Dari rencana ${plan.noDokumen}`,
    });

    const doc: ProductionResultDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen,
      productionPlanId: plan.id,
      productionPlanNo: plan.noDokumen,
      materialIssueId,
      materialIssueNo,
      tanggal: plan.tanggal,
      kitchenId: plan.kitchenId,
      kitchenNama: plan.kitchenNama,
      warehouseKode: seeded.warehouseKode,
      lines,
      status: 'DRAFT',
      history,
      summary,
      catatan: String(resultBody.catatan || '').trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };

    try {
      await db.collection(PRODUCTION_RESULTS_COLLECTION).insertOne(doc);
    } catch (e) {
      if (isDuplicateKeyError(e)) {
        return err('Hasil untuk rencana ini sedang dibuat — muat ulang', 409);
      }
      throw e;
    }

    await writeAuditLog(db, {
      tenantId,
      action: 'RESULT_CREATE',
      entityType: 'production_result',
      entityId: doc.id,
      summary: `Result ${doc.noDokumen} dari ${plan.noDokumen} (${doc.summary.lineCount} FG)`,
      ...auditActor(auth),
    });
    return ok(project(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'production-results' && path[1] && !path[2] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('Hasil produksi tidak ditemukan', 404);
    return ok(project(existing as Record<string, unknown>));
  }

  if (path[0] === 'production-results' && path[1] && !path[2] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: resultBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as ProductionResultDoc | null;
    if (!existing) return err('Hasil produksi tidak ditemukan', 404);
    if (!isResultEditable(existing.status)) {
      return err(`Status ${existing.status} tidak dapat diedit`, 400);
    }
    const normalized = normalizeResultLines(resultBody.lines != null ? resultBody.lines : existing.lines);
    if ('error' in normalized) return err(normalized.error, 400);
    const productErr = await assertResultProductsActive(db, existing.tenantId, normalized);
    if (productErr) return err(productErr, 400);
    const summary = {
      ...summarizeResultLines(normalized),
      warnings: existing.summary.warnings,
    };
    const now = new Date();
    await db.collection(PRODUCTION_RESULTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      {
        $set: {
          lines: normalized,
          summary,
          catatan: resultBody.catatan != null
            ? String(resultBody.catatan).trim() || undefined
            : existing.catatan,
          updatedAt: now,
        },
      },
    );
    const saved = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    return ok(project(saved as Record<string, unknown>));
  }

  if (path[0] === 'production-results' && path[1] && path[2] === 'status' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: resultBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const toStatus = String(resultBody.status || '').trim() as ProductionResultStatus;
    if (!toStatus || !KNOWN_STATUSES.has(toStatus)) return err('status tidak valid', 400);

    const existing = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as ProductionResultDoc | null;
    if (!existing) return err('Hasil produksi tidak ditemukan', 404);
    if (existing.status === toStatus) {
      return ok(project(existing as unknown as Record<string, unknown>));
    }
    const transitionErr = assertStatusTransition(existing.status, toStatus, RESULT_STATUS_TRANSITIONS);
    if (transitionErr) return err(transitionErr, 400);

    const actor = actorFields(auth);
    const now = new Date();

    if (toStatus === 'COMPLETED') {
      if (existing.stockPostedAt) return err('Dokumen sudah diselesaikan', 400);
      const needsStock = resultHasStockableLines(existing.lines);
      const productErr = await assertResultProductsActive(db, existing.tenantId, existing.lines);
      if (productErr) return err(productErr, 400);
      const issueGate = await loadIssueGate(db, scopeAuth, existing.productionPlanId);
      const gateErr = assertResultStockGate(issueGate);
      if (gateErr) return err(gateErr, 400);
      if (needsStock) {
        const locked = await guardPosting(
          db,
          scopeAuth,
          resultBody,
          postingDateFromIso(existing.tanggal),
        );
        if (locked) return locked;
      }

      try {
        await runInTransactionOrFallback(async ({ db: txDb, session }) => {
          if (needsStock && !session) {
            throw Object.assign(
              new Error('Posting stok Result membutuhkan transaksi MongoDB (replica set)'),
              { httpStatus: 503 },
            );
          }
          const fresh = await txDb.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
            withTenantFilter(scopeAuth, { id, status: existing.status }),
            txOpts(session),
          ) as ProductionResultDoc | null;
          if (!fresh) throw Object.assign(new Error('Dokumen berubah'), { httpStatus: 409 });

          const gateInTx = await loadIssueGate(txDb, scopeAuth, fresh.productionPlanId, session);
          const gateInTxErr = assertResultStockGate(gateInTx);
          if (gateInTxErr) {
            throw Object.assign(new Error(gateInTxErr), { httpStatus: 400 });
          }

          const productErrTx = await assertResultProductsActive(txDb, fresh.tenantId, fresh.lines);
          if (productErrTx) {
            throw Object.assign(new Error(productErrTx), { httpStatus: 400 });
          }

          const posted = await postResultStock(txDb, fresh, session);
          if ('error' in posted) {
            throw Object.assign(new Error(posted.error), { httpStatus: 400 });
          }

          const kitchen = await txDb.collection(KITCHENS_COLLECTION).findOne(
            withTenantFilter(scopeAuth, { id: fresh.kitchenId }),
            txOpts(session),
          ) as KitchenDoc | null;
          const expiryRaw = String(resultBody.expiryDate || '').trim();
          const expiryDate = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(expiryRaw)
            ? expiryRaw
            : defaultExpiryDate(fresh.tanggal);
          const batchNo = String(resultBody.batchNo || '').trim() || buildBatchNo({
            tanggal: fresh.tanggal,
            resultNo: fresh.noDokumen,
            kitchenKode: kitchen?.kode,
          });

          const wasteQty = 'wastePostedQty' in posted ? Number(posted.wastePostedQty || 0) : 0;
          const defaultNote = posted.postedLines > 0
            ? (wasteQty > 0
              ? `Stok masuk FG · waste write-off ${wasteQty} · batch ${batchNo}`
              : `Stok masuk FG · batch ${batchNo}`)
            : `Selesai MBG (porsi dicatat, tanpa post stok FG) · batch ${batchNo}`;
          const history = appendDocHistory(fresh.history, {
            at: now,
            fromStatus: fresh.status,
            toStatus: 'COMPLETED',
            userId: actor.userId,
            userName: actor.userName,
            note: String(resultBody.note || '').trim() || defaultNote,
          });
          await txDb.collection(PRODUCTION_RESULTS_COLLECTION).updateOne(
            withTenantFilter(scopeAuth, { id }),
            {
              $set: {
                status: 'COMPLETED',
                history,
                stockPostedAt: now,
                ...(wasteQty > 0 ? { wasteStockPostedAt: now } : {}),
                batchNo,
                expiryDate,
                updatedAt: now,
              },
            },
            txOpts(session),
          );

          const batchDocs: ProductionBatchDoc[] = [];
          for (const line of fresh.lines) {
            const fgId = String(line.finishedGoodProductId || '').trim();
            const gross = resultLineGrossPorsi(line);
            if (!fgId || !(gross > 0)) continue;
            const suffix = String(
              line.finishedGoodKode
              || line.recipeKode
              || line.menuKode
              || line.finishedGoodProductId
              || line.recipeId
              || 'LINE',
            ).slice(0, 12);
            batchDocs.push({
              id: uuidv4(),
              tenantId: fresh.tenantId,
              batchNo: `${batchNo}-${suffix}`,
              productionResultId: fresh.id,
              productionResultNo: fresh.noDokumen,
              productionPlanId: fresh.productionPlanId,
              productionPlanNo: fresh.productionPlanNo,
              kitchenId: fresh.kitchenId,
              kitchenNama: fresh.kitchenNama,
              warehouseKode: fresh.warehouseKode,
              producedAt: fresh.tanggal,
              expiryDate,
              finishedGoodProductId: line.finishedGoodProductId,
              finishedGoodNama: line.finishedGoodNama || line.recipeNama || line.menuNama || line.finishedGoodKode,
              qty: gross,
              qtyRemaining: gross,
              satuan: line.satuan,
              status: 'ACTIVE',
              createdAt: now,
              updatedAt: now,
            });
          }
          if (batchDocs.length) {
            await txDb.collection(PRODUCTION_BATCHES_COLLECTION).insertMany(batchDocs, txOpts(session));
          }

          // W2-15: FEFO-consume waste qty so batch remaining = actual good yield.
          for (const line of fresh.lines) {
            const fgId = String(line.finishedGoodProductId || '').trim();
            const waste = Number(line.wastePorsi) || 0;
            if (!fgId || !(waste > 0)) continue;
            await consumeBatchesFefo(
              txDb,
              {
                tenantId: fresh.tenantId,
                stokId: fgId,
                warehouseKode: fresh.warehouseKode,
                needQty: waste,
                asOf: now,
                allowExpired: true,
                productionResultId: fresh.id,
                noDokumen: fresh.noDokumen,
              },
              session,
            );
          }

          await maybeCompletePlan(txDb, scopeAuth, fresh.productionPlanId, session);
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

      const saved = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id }),
      );
      await writeAuditLog(db, {
        tenantId: existing.tenantId,
        action: 'RESULT_COMPLETE',
        entityType: 'production_result',
        entityId: id,
        summary: needsStock
          ? `Result ${existing.noDokumen} selesai — stok FG masuk`
          : `Result ${existing.noDokumen} selesai — MBG tanpa post stok FG`,
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
      note: String(resultBody.note || '').trim() || undefined,
    });
    await db.collection(PRODUCTION_RESULTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { status: toStatus, history, updatedAt: now } },
    );
    const saved = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'RESULT_STATUS',
      entityType: 'production_result',
      entityId: id,
      summary: `Result ${existing.noDokumen}: ${existing.status} → ${toStatus}`,
      ...auditActor(auth),
    });
    return ok(project(saved as Record<string, unknown>));
  }

  if (path[0] === 'production-results' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as ProductionResultDoc | null;
    if (!existing) return err('Hasil produksi tidak ditemukan', 404);
    if (existing.status === 'CANCELLED') return ok({ id: path[1], status: 'CANCELLED' });
    if (existing.status === 'COMPLETED') {
      return err('Dokumen selesai tidak dapat dibatalkan', 400);
    }
    const transitionErr = assertStatusTransition(existing.status, 'CANCELLED', RESULT_STATUS_TRANSITIONS);
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
    await db.collection(PRODUCTION_RESULTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      { $set: { status: 'CANCELLED', history, updatedAt: now } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'RESULT_CANCEL',
      entityType: 'production_result',
      entityId: path[1],
      summary: `Result ${existing.noDokumen} dibatalkan`,
      ...auditActor(auth),
    });
    return ok({ id: path[1], status: 'CANCELLED' });
  }

  return null;
}
