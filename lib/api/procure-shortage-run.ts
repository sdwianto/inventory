/**
 * Satu request: explode MRP sekali → APPROVED → PR + Draft CPO → submit vendor (enqueue).
 * Mengganti waterfall 7 HTTP dari UI "Menyiapkan PO…".
 */

import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { tenantIdForWrite, withTenantFilter } from '@/lib/api/tenant-master';
import { buildPlanMaterialExplosion } from '@/lib/api/handlers/material-requirements';
import { handlePurchaseRequirements } from '@/lib/api/handlers/purchase-requirements';
import { handleCustomerPo } from '@/lib/api/handlers/customer-po';
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
  MRP_ELIGIBLE_PLAN_STATUSES,
  type MaterialRequirementDoc,
} from '@/lib/food-production/material-requirement';
import {
  PRODUCTION_PLANS_COLLECTION,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import {
  FP_DOC_TYPES,
  appendDocHistory,
  type DocHistoryEntry,
} from '@/lib/food-production/document';
import { nextFpDocNumber } from '@/lib/food-production/document-number';
import type { HandlerContext } from '@/types/api/handler';

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
      noPO?: string;
      vendorSyncJobId?: string;
      submitError?: string;
      message?: string;
    }
  | { ok: false; error: string; status?: number };

async function readJson(res: NextResponse): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
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

  const linkedPo = await db.collection('customer_purchase_orders').findOne(
    withTenantFilter(opts.scopeAuth, {
      productionPlanId,
      status: { $nin: ['CANCELLED'] },
    }),
    { sort: { createdAt: -1 }, projection: { id: 1, noPO: 1, status: 1 } },
  );
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

  // Satu explode untuk seluruh jalur (bukan readiness + MRP create terpisah).
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
    note: 'Otomatis dari Rencana Produksi (procure)',
  });
  history = appendDocHistory(history, {
    at: now,
    fromStatus: 'SUBMITTED',
    toStatus: 'APPROVED',
    userId: actor.userId,
    userName: actor.userName,
    note: 'Otomatis dari Rencana Produksi (procure)',
  });

  await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateMany(
    withTenantFilter(opts.scopeAuth, {
      productionPlanId,
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
    tanggal: plan.tanggal,
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
    action: 'MRP_CREATE',
    entityType: 'material_requirement',
    entityId: mrp.id,
    summary: `MRP ${mrp.noDokumen} APPROVED (procure) dari ${plan.noDokumen} (${shortageCount} kekurangan)`,
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
      tanggalKedatangan: opts.tanggalKedatangan || plan.tanggal,
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

  const submitRes = await handleCustomerPo({
    db,
    auth: ctx.auth,
    request: ctx.request,
    url: ctx.url,
    method: 'POST',
    route: `/customer-purchase-orders/${draftCpoId}/submit`,
    path: ['customer-purchase-orders', draftCpoId, 'submit'],
    body: {},
  });
  if (!submitRes) {
    return {
      ok: true,
      mrpId: mrp.id,
      mrpNo: mrp.noDokumen,
      shortageCount,
      draftCpoId,
      draftCpoNo,
      submitError: 'Submit handler tidak tersedia',
      message: `PO ${draftCpoNo} dibuat (Draft) — buka PO ke Vendor untuk kirim`,
    };
  }
  const submitData = await readJson(submitRes);
  if (!submitRes.ok) {
    return {
      ok: true,
      mrpId: mrp.id,
      mrpNo: mrp.noDokumen,
      shortageCount,
      draftCpoId,
      draftCpoNo,
      submitError: String(submitData.error || 'perlu approval/submit'),
      message: `PO ${draftCpoNo} dibuat (Draft). Buka PO ke Vendor untuk kirim`,
    };
  }

  return {
    ok: true,
    mrpId: mrp.id,
    mrpNo: mrp.noDokumen,
    shortageCount,
    draftCpoId,
    draftCpoNo,
    poStatus: String(submitData.status || 'APPROVED'),
    noPO: String(submitData.noPO || draftCpoNo),
    vendorSyncJobId: submitData.vendorSyncJobId
      ? String(submitData.vendorSyncJobId)
      : undefined,
    message: `PO ${submitData.noPO || draftCpoNo} → ${submitData.status || 'APPROVED'}`,
  };
}
