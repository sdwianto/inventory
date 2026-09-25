/** Fase 3.2 — QC Penerimaan: antrean lot karantina/ditolak, inspeksi, pemusnahan. */

import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { requireRole, LOT_QC_INSPECT_ROLES, LOT_QC_VIEW_ROLES } from '@/lib/api/require-auth';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import { guardPosting } from '@/lib/api/period-lock';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import {
  INGREDIENT_LOTS_COLLECTION,
  effectiveIngredientQtyRemaining,
  effectiveLotQcStatus,
  type IngredientLotDoc,
} from '@/lib/food-production/ingredient-lot';
import {
  LOT_INSPECTIONS_COLLECTION,
  QC_TEMPERATURE_REQUIRED_WAREHOUSES,
  inspectIngredientLot,
  summarizeLotQc,
} from '@/lib/stock-ledger/lot-qc';
import { disposeRejectedLot } from '@/lib/stock-ledger/lot-qc-dispose';
import type { HandlerContext } from '@/types/api/handler';
import type { JsonObject } from '@/types/json';

const LIST_LIMIT = 300;

function lotRow(lot: IngredientLotDoc) {
  const qcStatus = effectiveLotQcStatus(lot);
  return {
    id: lot.id,
    lotNo: lot.lotNo,
    grnId: lot.grnId,
    noGRN: lot.noGRN,
    productId: lot.productId,
    productKode: lot.productKode,
    productNama: lot.productNama,
    warehouseKode: lot.warehouseKode,
    satuan: lot.satuan,
    qty: lot.qty,
    qtyRemaining: effectiveIngredientQtyRemaining(lot),
    receivedAt: lot.receivedAt,
    expiryDate: lot.expiryDate,
    supplierLotNo: lot.supplierLotNo,
    supplierId: lot.supplierId,
    qcStatus,
    temperatureRequired: (QC_TEMPERATURE_REQUIRED_WAREHOUSES as readonly string[]).includes(String(lot.warehouseKode || '').toUpperCase()),
    receivedByUserId: lot.receivedByUserId,
    noInspeksi: lot.noInspeksi,
    qcInspectedAt: lot.qcInspectedAt,
    qcSplitFromLotId: lot.qcSplitFromLotId,
    qcRejectStatus: qcStatus === 'REJECTED' ? (lot.qcRejectStatus || 'PENDING') : undefined,
    qcRejectReason: lot.qcRejectReason,
    qcRejectRtvId: lot.qcRejectRtvId,
    qcRejectNoReturn: lot.qcRejectNoReturn,
    qcDisposal: lot.qcDisposal,
    createdAt: lot.createdAt,
  };
}

export async function handleLotQc({ db, route, method, path, body, url, auth, request }: HandlerContext): Promise<NextResponse | null> {
  const qcBody = (body || {}) as Record<string, unknown>;

  // GET /lot-qc?view=queue|rejected|history&q=
  if (route === '/lot-qc' && method === 'GET') {
    const denied = requireRole(auth, LOT_QC_VIEW_ROLES);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, request });
    if (scope.denied) return scope.denied;
    const tenantId = scope.tenantId;
    if (!tenantId) return err('Pilih tenant operasional terlebih dahulu', 400);

    const view = String(url.searchParams.get('view') || 'queue');
    const q = String(url.searchParams.get('q') || '').trim();
    const filter: Record<string, unknown> = { tenantId };
    if (view === 'rejected') {
      filter.qcStatus = 'REJECTED';
      filter.status = { $in: ['ACTIVE', 'EXPIRED'] };
    } else if (view === 'history') {
      filter.qcInspectionId = { $exists: true };
    } else {
      filter.qcStatus = 'QUARANTINE';
      filter.status = { $in: ['ACTIVE', 'EXPIRED'] };
    }
    if (q) {
      const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filter.$or = [{ lotNo: rx }, { noGRN: rx }, { productKode: rx }, { productNama: rx }, { supplierLotNo: rx }];
    }
    const sort: Record<string, 1 | -1> = view === 'history' ? { qcInspectedAt: -1 } : { createdAt: 1 };
    const [rows, summary, enabled] = await Promise.all([
      db.collection(INGREDIENT_LOTS_COLLECTION).find(filter).sort(sort).limit(LIST_LIMIT).toArray(),
      summarizeLotQc(db, tenantId),
      isTenantFeatureEnabled(db, tenantId, 'lotQcRequired'),
    ]);
    return ok({
      enabled,
      summary,
      lots: (rows as unknown as IngredientLotDoc[]).map(lotRow),
    });
  }

  // GET /lot-qc/inspections?lotId=
  if (path[0] === 'lot-qc' && path[1] === 'inspections' && !path[2] && method === 'GET') {
    const denied = requireRole(auth, LOT_QC_VIEW_ROLES);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, request });
    if (scope.denied) return scope.denied;
    if (!scope.tenantId) return err('Pilih tenant operasional terlebih dahulu', 400);
    const lotId = String(url.searchParams.get('lotId') || '').trim();
    const filter: Record<string, unknown> = { tenantId: scope.tenantId };
    if (lotId) filter.$or = [{ lotId }, { rejectedLotId: lotId }];
    const rows = await db.collection(LOT_INSPECTIONS_COLLECTION).find(filter).sort({ inspectedAt: -1 }).limit(LIST_LIMIT).toArray();
    return ok(rows.map((r) => clean(r as JsonObject)));
  }

  // POST /lot-qc/:lotId/inspect
  if (path[0] === 'lot-qc' && path[1] && path[2] === 'inspect' && method === 'POST') {
    const denied = requireRole(auth, LOT_QC_INSPECT_ROLES);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, body: qcBody, request });
    if (scope.denied) return scope.denied;
    if (!scope.tenantId || !auth?.userId) return err('Pilih tenant operasional terlebih dahulu', 400);
    const res = await inspectIngredientLot(db, {
      tenantId: scope.tenantId,
      lotId: String(path[1]),
      qtyPassed: qcBody.qtyPassed,
      qtyFailed: qcBody.qtyFailed,
      suhuC: qcBody.suhuC,
      kondisi: qcBody.kondisi,
      alasanTolak: qcBody.alasanTolak,
      catatan: qcBody.catatan,
      actor: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role, isMaster: auth.isMaster },
    });
    if (!res.ok) return err(res.error, res.status);
    return ok({
      inspection: clean({ ...res.inspection } as unknown as JsonObject),
      lot: lotRow(res.lot),
      ...(res.rejectedLot ? { rejectedLot: lotRow(res.rejectedLot) } : {}),
    });
  }

  // POST /lot-qc/:lotId/dispose — musnahkan lot ditolak (stok keluar + jurnal kerugian)
  if (path[0] === 'lot-qc' && path[1] && path[2] === 'dispose' && method === 'POST') {
    const denied = requireRole(auth, LOT_QC_INSPECT_ROLES);
    if (denied) return denied;
    const scope = resolveOperationalScope(auth, { url, body: qcBody, request });
    if (scope.denied) return scope.denied;
    if (!scope.tenantId || !auth?.userId) return err('Pilih tenant operasional terlebih dahulu', 400);
    const locked = await guardPosting(db, scope.scopeAuth, qcBody);
    if (locked) return locked;
    const res = await disposeRejectedLot(db, {
      tenantId: scope.tenantId,
      lotId: String(path[1]),
      reason: qcBody.reason,
      actor: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
    });
    if (!res.ok) return err(res.error, res.status);
    await invalidateDashboardSnapshot(db, scope.tenantId);
    return ok(res);
  }

  return null;
}
