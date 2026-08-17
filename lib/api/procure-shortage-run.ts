/**
 * Satu request: explode MRP sekali → APPROVED → PR + Draft CPO (tanpa submit vendor).
 * Human gate: review/edit Draft PO di /pembelian-po, lalu Ajukan/Kirim.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { tenantIdForWrite, withTenantFilter } from '@/lib/api/tenant-master';
import { buildPlanMaterialExplosion } from '@/lib/api/handlers/material-requirements';
import { handlePurchaseRequirements } from '@/lib/api/handlers/purchase-requirements';
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
  MRP_ELIGIBLE_PLAN_STATUSES,
  type MaterialRequirementDoc,
} from '@/lib/food-production/material-requirement';
import {
  PRODUCTION_PLANS_COLLECTION,
  cookDateFromPlanTanggal,
  resolveProcureArrivalDate,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import {
  PURCHASE_REQUIREMENTS_COLLECTION,
} from '@/lib/food-production/purchase-requirement';
import {
  FP_DOC_TYPES,
  appendDocHistory,
  type DocHistoryEntry,
} from '@/lib/food-production/document';
import { nextFpDocNumber } from '@/lib/food-production/document-number';
import type { HandlerContext } from '@/types/api/handler';

const REFRESHABLE_PO_STATUSES = new Set(['DRAFT', 'REJECTED']);

export type ProcureShortageResult =
  | {
      ok: true;
      materialsReady?: boolean;
      linkedPo?: { id: string; noPO?: string; status?: string };
      mrpId?: string;
      mrpNo?: string;
      shortageCount?: number;
      draftCpoId?: string;
      draftCpoNo?: string;
      poStatus?: string;
      message?: string;
      refreshed?: boolean;
    }
  | { ok: false; error: string; status?: number };

async function readJson(res: NextResponse): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function findLinkedPo(
  db: Db,
  scopeAuth: NonNullable<HandlerContext['auth']>,
  productionPlanId: string,
) {
  return db.collection('customer_purchase_orders').findOne(
    withTenantFilter(scopeAuth, {
      productionPlanId,
      status: { $nin: ['CANCELLED'] },
    }),
    { sort: { createdAt: -1 }, projection: { id: 1, noPO: 1, status: 1 } },
  );
}

async function cancelDraftCpo(
  db: Db,
  tenantId: string,
  cpoId: string,
  reason: string,
  actor: { userId?: string; userName?: string },
): Promise<void> {
  const id = String(cpoId || '').trim();
  if (!id) return;
  const cpo = await db.collection('customer_purchase_orders').findOne({ id, tenantId });
  if (!cpo || cpo.status !== 'DRAFT') return;
  const now = new Date();
  await db.collection('customer_purchase_orders').updateOne(
    { id, tenantId },
    {
      $set: {
        status: 'CANCELLED',
        cancelledBy: { userId: actor.userId, name: actor.userName },
        cancelledAt: now,
        cancelReason: reason,
        updatedAt: now,
      },
    },
  );
}

async function cancelDraftPrsForPlan(
  db: Db,
  scopeAuth: NonNullable<HandlerContext['auth']>,
  productionPlanId: string,
  actor: { userId?: string; userName?: string },
  reason: string,
): Promise<void> {
  const tenantId = tenantIdForWrite(scopeAuth, {});
  const now = new Date();
  const prs = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION)
    .find(withTenantFilter(scopeAuth, {
      productionPlanId,
      status: 'DRAFT',
    }))
    .toArray();
  for (const pr of prs) {
    await cancelDraftCpo(db, tenantId, String(pr.draftCpoId || ''), reason, actor);
    await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: String(pr.id) }),
      { $set: { status: 'CANCELLED', updatedAt: now } },
    );
  }
}

async function cancelProcureMrpsForPlan(
  db: Db,
  scopeAuth: NonNullable<HandlerContext['auth']>,
  productionPlanId: string,
  now: Date,
): Promise<void> {
  await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateMany(
    withTenantFilter(scopeAuth, {
      productionPlanId,
      status: { $in: ['DRAFT', 'APPROVED'] },
    }),
    { $set: { status: 'CANCELLED', updatedAt: now } },
  );
}

async function runProcureShortageCore(
  db: Db,
  ctx: Pick<HandlerContext, 'auth' | 'request' | 'url'>,
  opts: {
    productionPlanId: string;
    scopeAuth: NonNullable<HandlerContext['auth']>;
    tanggalKedatangan?: string;
    catatan?: string;
    refreshed?: boolean;
  },
  plan: ProductionPlanDoc,
): Promise<ProcureShortageResult> {
  const built = await buildPlanMaterialExplosion(db, opts.scopeAuth, plan);
  if ('error' in built && built.error) {
    return { ok: false, error: String(built.error), status: 400 };
  }

  const shortageCount = Number(built.summary?.shortageCount || 0);
  if (shortageCount === 0) {
    return {
      ok: true,
      materialsReady: true,
      shortageCount: 0,
      message: 'Bahan lengkap — siap Ambil Bahan',
    };
  }

  const tenantId = tenantIdForWrite(opts.scopeAuth, {});
  const now = new Date();
  const actor = auditActor(ctx.auth);
  const noDokumen = await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.MATERIAL_REQUIREMENT);

  let history: DocHistoryEntry[] = appendDocHistory([], {
    at: now,
    fromStatus: null,
    toStatus: 'DRAFT',
    userId: actor.userId,
    userName: actor.userName,
    note: `Dihitung dari rencana ${plan.noDokumen}`,
  });
  history = appendDocHistory(history, {
    at: now,
    fromStatus: 'DRAFT',
    toStatus: 'SUBMITTED',
    userId: actor.userId,
    userName: actor.userName,
    note: opts.refreshed
      ? 'Otomatis dari Rencana Produksi (perbarui draft belanja)'
      : 'Otomatis dari Rencana Produksi (procure)',
  });
  history = appendDocHistory(history, {
    at: now,
    fromStatus: 'SUBMITTED',
    toStatus: 'APPROVED',
    userId: actor.userId,
    userName: actor.userName,
    note: opts.refreshed
      ? 'Otomatis dari Rencana Produksi (perbarui draft belanja)'
      : 'Otomatis dari Rencana Produksi (procure)',
  });

  await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateMany(
    withTenantFilter(opts.scopeAuth, {
      productionPlanId: opts.productionPlanId,
      status: 'DRAFT',
    }),
    { $set: { status: 'CANCELLED', updatedAt: now } },
  );

  const mrp: MaterialRequirementDoc = {
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
    status: 'APPROVED',
    history,
    summary: built.summary!,
    acuanByKategori: built.acuanByKategori ?? null,
    catatan: String(opts.catatan || '').trim() || undefined,
    createdAt: now,
    updatedAt: now,
    createdBy: actor.userId,
    createdByName: actor.userName,
  };
  await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).insertOne(mrp);
  await writeAuditLog(db, {
    tenantId,
    action: opts.refreshed ? 'PROCURE_DRAFT_REFRESH' : 'MRP_CREATE',
    entityType: 'material_requirement',
    entityId: mrp.id,
    summary: opts.refreshed
      ? `MRP ${mrp.noDokumen} APPROVED (refresh draft) dari ${plan.noDokumen} (${shortageCount} kekurangan)`
      : `MRP ${mrp.noDokumen} APPROVED (procure) dari ${plan.noDokumen} (${shortageCount} kekurangan)`,
    ...actor,
  });

  const prRes = await handlePurchaseRequirements({
    db,
    auth: ctx.auth,
    request: ctx.request,
    url: ctx.url,
    method: 'POST',
    route: '/purchase-requirements',
    path: ['purchase-requirements'],
    body: {
      materialRequirementId: mrp.id,
      tanggalKedatangan: resolveProcureArrivalDate(plan.tanggal, opts.tanggalKedatangan),
      catatan: opts.catatan || `Dari rencana ${plan.noDokumen}`,
    },
  });
  if (!prRes) return { ok: false, error: 'Handler PR tidak tersedia', status: 500 };
  const prData = await readJson(prRes);
  if (!prRes.ok) {
    return {
      ok: false,
      error: String(prData.error || 'Gagal buat PO dari kekurangan'),
      status: prRes.status,
    };
  }

  const draftCpoId = String(prData.draftCpoId || '');
  const draftCpoNo = String(prData.draftCpoNo || '');
  if (!draftCpoId) {
    return { ok: false, error: 'Draft PO tidak terbentuk', status: 500 };
  }

  return {
    ok: true,
    mrpId: mrp.id,
    mrpNo: mrp.noDokumen,
    shortageCount,
    draftCpoId,
    draftCpoNo,
    poStatus: 'DRAFT',
    refreshed: opts.refreshed === true,
    message: opts.refreshed
      ? `Draft PO ${draftCpoNo} diperbarui — review & edit sebelum kirim ke vendor`
      : `Draft PO ${draftCpoNo} siap — review & edit sebelum kirim ke vendor`,
  };
}

export async function runProcureShortageFromPlan(
  db: Db,
  ctx: Pick<HandlerContext, 'auth' | 'request' | 'url'>,
  opts: {
    productionPlanId: string;
    scopeAuth: NonNullable<HandlerContext['auth']>;
    tanggalKedatangan?: string;
    catatan?: string;
  },
): Promise<ProcureShortageResult> {
  const productionPlanId = String(opts.productionPlanId || '').trim();
  if (!productionPlanId) return { ok: false, error: 'productionPlanId wajib', status: 400 };

  const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
    withTenantFilter(opts.scopeAuth, { id: productionPlanId }),
  ) as ProductionPlanDoc | null;
  if (!plan) return { ok: false, error: 'Rencana produksi tidak ditemukan', status: 404 };
  if (!MRP_ELIGIBLE_PLAN_STATUSES.has(plan.status)) {
    return {
      ok: false,
      error: `Rencana status ${plan.status} belum siap untuk MRP (minimal Diajukan)`,
      status: 400,
    };
  }

  const linkedPo = await findLinkedPo(db, opts.scopeAuth, productionPlanId);
  if (linkedPo) {
    return {
      ok: true,
      linkedPo: {
        id: String(linkedPo.id),
        noPO: linkedPo.noPO ? String(linkedPo.noPO) : undefined,
        status: linkedPo.status ? String(linkedPo.status) : undefined,
      },
      message: `PO ${linkedPo.noPO || ''} sudah ada (${linkedPo.status})`,
    };
  }

  return runProcureShortageCore(db, ctx, { ...opts, productionPlanId }, plan);
}

export async function runRefreshProcureDraftFromPlan(
  db: Db,
  ctx: Pick<HandlerContext, 'auth' | 'request' | 'url'>,
  opts: {
    productionPlanId: string;
    scopeAuth: NonNullable<HandlerContext['auth']>;
    tanggalKedatangan?: string;
    catatan?: string;
  },
): Promise<ProcureShortageResult> {
  const productionPlanId = String(opts.productionPlanId || '').trim();
  if (!productionPlanId) return { ok: false, error: 'productionPlanId wajib', status: 400 };

  const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
    withTenantFilter(opts.scopeAuth, { id: productionPlanId }),
  ) as ProductionPlanDoc | null;
  if (!plan) return { ok: false, error: 'Rencana produksi tidak ditemukan', status: 404 };
  if (!MRP_ELIGIBLE_PLAN_STATUSES.has(plan.status)) {
    return {
      ok: false,
      error: `Rencana status ${plan.status} belum siap untuk MRP (minimal Diajukan)`,
      status: 400,
    };
  }

  const linkedPo = await findLinkedPo(db, opts.scopeAuth, productionPlanId);
  if (!linkedPo) {
    return { ok: false, error: 'Belum ada Draft PO — gunakan Buat Draft Belanja', status: 400 };
  }

  const poStatus = String(linkedPo.status || '').toUpperCase();
  if (!REFRESHABLE_PO_STATUSES.has(poStatus)) {
    return {
      ok: false,
      error: `PO ${linkedPo.noPO || ''} status ${poStatus} — tidak bisa diperbarui (hanya Draft/Rejected)`,
      status: 400,
    };
  }

  const actor = auditActor(ctx.auth);
  const tenantId = tenantIdForWrite(opts.scopeAuth, {});
  const supersedeReason = 'Digantikan draft belanja baru (perbarui dari rencana)';
  const now = new Date();

  if (poStatus === 'DRAFT') {
    await cancelDraftCpo(db, tenantId, String(linkedPo.id), supersedeReason, actor);
  }
  await cancelDraftPrsForPlan(db, opts.scopeAuth, productionPlanId, actor, supersedeReason);
  await cancelProcureMrpsForPlan(db, opts.scopeAuth, productionPlanId, now);

  return runProcureShortageCore(db, ctx, {
    ...opts,
    productionPlanId,
    refreshed: true,
  }, plan);
}
