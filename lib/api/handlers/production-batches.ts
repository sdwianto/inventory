import type { NextResponse } from 'next/server';
import { NextResponse as NextRes } from 'next/server';
import { ok, err, clean, cors } from '@/lib/api/db';
import { withTenantFilter, resolveOperationalScope } from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import {
  PRODUCTION_BATCHES_COLLECTION,
  daysUntilExpiry,
  effectiveFoodSafetyStatus,
  effectiveQtyRemaining,
  isExpired,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import { FP_MANAGE_ROLES } from '@/lib/food-production/roles';
import { getBatchAssuranceTrail } from '@/lib/kitchen-assurance';
import { PRODUCTION_PLANS_COLLECTION } from '@/lib/food-production/production-plan';
import { PRODUCTION_RESULTS_COLLECTION } from '@/lib/food-production/production-result';
import { MATERIAL_ISSUES_COLLECTION } from '@/lib/food-production/material-issue';
import { DISTRIBUTION_ORDERS_COLLECTION } from '@/lib/food-production/distribution';
import { INGREDIENT_LOTS_COLLECTION } from '@/lib/food-production/ingredient-lot';
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
        qtyRemaining: effectiveQtyRemaining(b),
        foodSafetyStatus: effectiveFoodSafetyStatus(b),
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

    // ADR-004 P0D/P0E — HOLD/RELEASE harus terlihat di export trail (Auditability).
    for (const h of batch.foodSafetyHistory || []) {
      const at = h.at instanceof Date ? h.at.toISOString() : String(h.at || '');
      const from = h.fromStatus != null ? String(h.fromStatus) : '—';
      const to = String(h.toStatus || '');
      events.push({
        at,
        eventType: 'FOOD_SAFETY',
        entityType: 'production_batch',
        entityId: batch.id,
        refNo: h.sourceType || undefined,
        summary: h.note || `Food safety ${from} → ${to}`,
        statusOrAlert: to,
        userName: h.userName ? String(h.userName) : undefined,
      });
    }

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

    // Kitchen Assurance boundary — production-batches.ts no longer queries
    // qc_results / temperature_logs / haccp_results directly (Sprint 2 Step 1).
    const assurance = await getBatchAssuranceTrail(db, scopeAuth, {
      productionBatchId: batchId,
      productionPlanId: batch.productionPlanId,
    });
    events.push(...assurance.events);

    // ADR-004 Fase 6 — LOT (candidate from material issue allocations) + DIST.
    if (batch.productionPlanId) {
      const issues = await db.collection(MATERIAL_ISSUES_COLLECTION).find(
        withTenantFilter(scopeAuth, {
          productionPlanId: batch.productionPlanId,
          status: { $nin: ['CANCELLED'] },
        }),
      ).project({
        id: 1,
        noDokumen: 1,
        stockPostedAt: 1,
        createdAt: 1,
        fefoConsume: 1,
      }).limit(50).toArray();

      const lotIds = new Set<string>();
      for (const iss of issues) {
        for (const fc of (iss.fefoConsume || []) as Array<{ allocations?: unknown[] }>) {
          for (const a of fc.allocations || []) {
            const id = String((a as { batchId?: string }).batchId || '').trim();
            if (id) lotIds.add(id);
          }
        }
        const at = iss.stockPostedAt instanceof Date
          ? iss.stockPostedAt.toISOString()
          : iss.createdAt instanceof Date
            ? iss.createdAt.toISOString()
            : '';
        events.push({
          at,
          eventType: 'LOT',
          entityType: 'material_issue',
          entityId: String(iss.id),
          refNo: String(iss.noDokumen || ''),
          summary: `Issue bahan ${iss.noDokumen} (candidate lot inference)`,
          statusOrAlert: 'CANDIDATE',
        });
      }

      if (lotIds.size) {
        const lots = await db.collection(INGREDIENT_LOTS_COLLECTION).find(
          withTenantFilter(scopeAuth, { id: { $in: [...lotIds] } }),
        ).project({ id: 1, lotNo: 1, supplierId: 1, noGRN: 1, productNama: 1, receivedAt: 1 }).limit(100).toArray();
        for (const lot of lots) {
          events.push({
            at: String(lot.receivedAt || ''),
            eventType: 'LOT',
            entityType: 'ingredient_lot',
            entityId: String(lot.id),
            refNo: String(lot.lotNo || ''),
            summary: `Lot ${lot.lotNo || lot.id} · ${lot.productNama || ''}${
              lot.supplierId ? ` · supplier ${lot.supplierId}` : ''
            }${lot.noGRN ? ` · ${lot.noGRN}` : ''}`.trim(),
            statusOrAlert: 'CANDIDATE',
          });
        }
      }

      const dists = await db.collection(DISTRIBUTION_ORDERS_COLLECTION).find(
        withTenantFilter(scopeAuth, {
          productionPlanId: batch.productionPlanId,
          status: { $nin: ['CANCELLED'] },
        }),
      ).project({
        id: 1,
        noDokumen: 1,
        status: 1,
        stockPostedAt: 1,
        createdAt: 1,
        fefoConsume: 1,
      }).limit(50).toArray();

      for (const d of dists) {
        const usedBatch = ((d.fefoConsume || []) as Array<{ allocations?: unknown[] }>)
          .some((fc) => (fc.allocations || []).some(
            (a) => String((a as { batchId?: string }).batchId || '') === batch.id,
          ));
        const at = d.stockPostedAt instanceof Date
          ? d.stockPostedAt.toISOString()
          : d.createdAt instanceof Date
            ? d.createdAt.toISOString()
            : '';
        events.push({
          at,
          eventType: 'DIST',
          entityType: 'distribution_order',
          entityId: String(d.id),
          refNo: String(d.noDokumen || ''),
          summary: `Distribusi ${d.noDokumen}${usedBatch ? ' · alokasi batch ini' : ' · plan (candidate)'}`,
          statusOrAlert: String(d.status || ''),
        });
      }
    }

    const entityIds = [
      batch.id,
      batch.productionPlanId,
      batch.productionResultId,
      ...assurance.entityIds,
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
        foodSafetyStatus: effectiveFoodSafetyStatus(batch),
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
