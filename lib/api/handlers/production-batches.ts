import type { NextResponse } from 'next/server';
import { NextResponse as NextRes } from 'next/server';
import { ok, err, clean, cors } from '@/lib/api/db';
import { withTenantFilter, resolveOperationalScope } from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import {
  PRODUCTION_BATCHES_COLLECTION,
  daysUntilExpiry,
  isExpired,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import { FP_MANAGE_ROLES } from '@/lib/food-production/roles';
import { TEMPERATURE_LOGS_COLLECTION, type TemperatureLogDoc } from '@/lib/food-production/temperature-log';
import { QC_RESULTS_COLLECTION, type QcResultDoc } from '@/lib/food-production/qc';
import { HACCP_RESULTS_COLLECTION, type HaccpResultDoc } from '@/lib/food-production/haccp';
import { PRODUCTION_PLANS_COLLECTION } from '@/lib/food-production/production-plan';
import { PRODUCTION_RESULTS_COLLECTION } from '@/lib/food-production/production-result';
import {
  batchTrailToCsv,
  sortTrailEvents,
  type BatchAuditTrail,
  type BatchTrailEvent,
} from '@/lib/food-production/batch-audit-trail';
import type { HandlerContext } from '@/types/api/handler';

export async function handleProductionBatches(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request } = ctx;

  if (route === '/production-batches' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const kitchenId = resolveKitchenIdFilter(url, request);
    const expiringWithin = Number(url.searchParams.get('expiringWithinDays'));
    const status = String(url.searchParams.get('status') || '').trim().toUpperCase();
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);

    // Persist overdue ACTIVE → EXPIRED so filters / public API stay truthful.
    await db.collection(PRODUCTION_BATCHES_COLLECTION).updateMany(
      withTenantFilter(scopeAuth, { status: 'ACTIVE', expiryDate: { $lt: todayIso } }),
      { $set: { status: 'EXPIRED', updatedAt: today } },
    );

    const filter: Record<string, unknown> = {};
    if (kitchenId) filter.kitchenId = kitchenId;
    if (status === 'ACTIVE' || status === 'EXPIRED' || status === 'CONSUMED') {
      filter.status = status;
    }

    const list = await db.collection(PRODUCTION_BATCHES_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ expiryDate: 1 })
      .limit(300)
      .toArray() as unknown as ProductionBatchDoc[];

    const enriched = list.map((b) => {
      const expired = b.status === 'EXPIRED' || isExpired(b.expiryDate, today);
      const daysLeft = daysUntilExpiry(b.expiryDate, today);
      return {
        ...b,
        expired,
        daysUntilExpiry: daysLeft,
        status: expired && b.status === 'ACTIVE' ? 'EXPIRED' : b.status,
      };
    }).filter((b) => {
      if (!Number.isFinite(expiringWithin) || expiringWithin < 0) return true;
      if (b.daysUntilExpiry == null) return false;
      return b.daysUntilExpiry <= expiringWithin;
    });

    return ok(enriched.map((d) => clean(d as unknown as Record<string, unknown>)));
  }

  // GET /production-batches/:id/audit-trail?export=json|csv
  if (
    path[0] === 'production-batches'
    && path[1]
    && path[2] === 'audit-trail'
    && !path[3]
    && method === 'GET'
  ) {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const batchId = path[1];
    const batch = await db.collection(PRODUCTION_BATCHES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: batchId }),
    ) as ProductionBatchDoc | null;
    if (!batch) return err('Batch tidak ditemukan', 404);

    const events: BatchTrailEvent[] = [];

    events.push({
      at: batch.createdAt instanceof Date
        ? batch.createdAt.toISOString()
        : String(batch.createdAt || batch.producedAt),
      eventType: 'BATCH',
      entityType: 'production_batch',
      entityId: batch.id,
      refNo: batch.batchNo,
      summary: `Batch ${batch.batchNo} · ${batch.finishedGoodNama || 'FG'} · qty ${batch.qty}`,
      statusOrAlert: batch.status,
    });

    if (batch.productionPlanId) {
      const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: batch.productionPlanId }),
        { projection: { id: 1, noDokumen: 1, status: 1, tanggal: 1, createdAt: 1 } },
      );
      if (plan) {
        events.push({
          at: plan.createdAt instanceof Date
            ? plan.createdAt.toISOString()
            : String(plan.tanggal || ''),
          eventType: 'PLAN',
          entityType: 'production_plan',
          entityId: String(plan.id),
          refNo: String(plan.noDokumen || ''),
          summary: `Rencana ${plan.noDokumen}`,
          statusOrAlert: String(plan.status || ''),
        });
      }
    }

    if (batch.productionResultId) {
      const result = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: batch.productionResultId }),
        { projection: { id: 1, noDokumen: 1, status: 1, tanggal: 1, createdAt: 1 } },
      );
      if (result) {
        events.push({
          at: result.createdAt instanceof Date
            ? result.createdAt.toISOString()
            : String(result.tanggal || ''),
          eventType: 'RESULT',
          entityType: 'production_result',
          entityId: String(result.id),
          refNo: String(result.noDokumen || ''),
          summary: `Hasil produksi ${result.noDokumen}`,
          statusOrAlert: String(result.status || ''),
        });
      }
    }

    const tempLogs = await db.collection(TEMPERATURE_LOGS_COLLECTION)
      .find(withTenantFilter(scopeAuth, { productionBatchId: batchId }))
      .sort({ recordedAt: 1 })
      .limit(200)
      .toArray() as unknown as TemperatureLogDoc[];
    for (const t of tempLogs) {
      events.push({
        at: t.recordedAt instanceof Date ? t.recordedAt.toISOString() : String(t.tanggal),
        eventType: 'TEMP_LOG',
        entityType: 'temperature_log',
        entityId: t.id,
        refNo: t.stage,
        summary: `Suhu ${t.stage} ${t.suhuC}°C`,
        statusOrAlert: t.alertStatus,
      });
    }

    const qcFilter: Record<string, unknown> = {};
    if (batch.productionPlanId) qcFilter.productionPlanId = batch.productionPlanId;
    const qcList = qcFilter.productionPlanId
      ? await db.collection(QC_RESULTS_COLLECTION)
        .find(withTenantFilter(scopeAuth, qcFilter))
        .sort({ createdAt: 1 })
        .limit(100)
        .toArray() as unknown as QcResultDoc[]
      : [];
    for (const q of qcList) {
      events.push({
        at: q.createdAt instanceof Date ? q.createdAt.toISOString() : String(q.tanggal),
        eventType: 'QC',
        entityType: 'qc_result',
        entityId: q.id,
        refNo: q.noDokumen,
        summary: `QC ${q.noDokumen} (${q.templateKode || q.category})`,
        statusOrAlert: q.status,
      });
    }

    const haccpList = await db.collection(HACCP_RESULTS_COLLECTION)
      .find(withTenantFilter(scopeAuth, { productionBatchId: batchId }))
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray() as unknown as HaccpResultDoc[];
    for (const h of haccpList) {
      const firstPhoto = (h.evidenceUrls || [])[0];
      events.push({
        at: h.createdAt instanceof Date ? h.createdAt.toISOString() : String(h.tanggal),
        eventType: 'HACCP',
        entityType: 'haccp_result',
        entityId: h.id,
        refNo: h.noDokumen,
        summary: `HACCP ${h.noDokumen} (${h.templateKode || h.category}) · foto ${h.summary?.photoCount || 0}`,
        statusOrAlert: h.status,
        evidenceUrl: firstPhoto,
        userName: h.createdByName,
      });
    }

    const entityIds = [
      batch.id,
      batch.productionPlanId,
      batch.productionResultId,
      ...haccpList.map((h) => h.id),
      ...qcList.map((q) => q.id),
      ...tempLogs.map((t) => t.id),
    ].filter(Boolean);

    const auditRows = await db.collection('audit_log')
      .find(withTenantFilter(scopeAuth, { entityId: { $in: entityIds } }))
      .sort({ createdAt: 1 })
      .limit(500)
      .toArray();
    for (const a of auditRows) {
      const createdAt = a.createdAt instanceof Date
        ? a.createdAt.toISOString()
        : String(a.createdAt || '');
      events.push({
        at: createdAt,
        eventType: 'AUDIT',
        entityType: String(a.entityType || 'audit'),
        entityId: String(a.entityId || ''),
        refNo: String(a.action || ''),
        summary: String(a.summary || a.action || ''),
        userName: a.userName ? String(a.userName) : undefined,
      });
    }

    const trail: BatchAuditTrail = {
      batch: {
        id: batch.id,
        batchNo: batch.batchNo,
        status: batch.status,
        kitchenNama: batch.kitchenNama,
        productionPlanId: batch.productionPlanId,
        productionPlanNo: batch.productionPlanNo,
        productionResultId: batch.productionResultId,
        productionResultNo: batch.productionResultNo,
        expiryDate: batch.expiryDate,
        finishedGoodNama: batch.finishedGoodNama,
      },
      events: sortTrailEvents(events),
    };

    const format = String(url.searchParams.get('export') || 'json').toLowerCase();
    if (format === 'csv') {
      const csv = batchTrailToCsv(trail);
      const res = new NextRes(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="batch-trail-${batch.batchNo || batch.id}.csv"`,
        },
      });
      return cors(res);
    }
    return ok(trail);
  }

  return null;
}
