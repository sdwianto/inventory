/**
 * Kitchen Assurance boundary — Sprint 2 Step 1 (docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md).
 *
 * "Decouple first, extract implementation second." Consumers outside Kitchen Assurance
 * (mis. production-batches.ts) call the functions in this file instead of querying
 * qc_results / temperature_logs / haccp_results directly. The implementation below still
 * reads those collections from their current location (lib/food-production/*) — moving
 * qc.ts / temperature-log.ts / haccp.ts into lib/kitchen-assurance/ is a later, separate
 * step and does not require touching any consumer again.
 */

import type { Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import { withTenantFilter } from '@/lib/api/tenant-master';
import { TEMPERATURE_LOGS_COLLECTION, type TemperatureLogDoc } from '@/lib/food-production/temperature-log';
import { QC_RESULTS_COLLECTION, type QcResultDoc } from '@/lib/food-production/qc';
import {
  HACCP_RESULTS_COLLECTION,
  HACCP_DISPOSITION_LABELS,
  effectiveHaccpDisposition,
  type HaccpResultDoc,
} from '@/lib/food-production/haccp';
import type { BatchTrailEvent } from '@/lib/food-production/batch-audit-trail';

export type BatchAssuranceTrailParams = {
  productionBatchId: string;
  /** QC results are keyed by plan, not batch — pass along when available. */
  productionPlanId?: string;
};

export type BatchAssuranceTrail = {
  events: BatchTrailEvent[];
  /** qc/temperature-log/haccp doc ids — for correlating audit_log entries upstream. */
  entityIds: string[];
};

/**
 * Historical assurance trail for one production batch (temperature log readings,
 * QC results, HACCP results) — used to compose the full batch audit trail together
 * with Inventory's own BATCH/PLAN/RESULT/AUDIT events (see production-batches.ts).
 *
 * Used by audit/export consumers. Not intended for real-time monitoring — Kitchen
 * Assurance's own monitoring/analytics/reports still read temperature-log.ts directly
 * for live signals, which is a different need (current state vs historical trail).
 *
 * This is the single boundary between Inventory and Kitchen Assurance for batch audit
 * trail purposes: callers never see qc_results / temperature_logs / haccp_results shapes.
 */
export async function getBatchAssuranceTrail(
  db: Db,
  scopeAuth: AuthContext | null | undefined,
  params: BatchAssuranceTrailParams,
): Promise<BatchAssuranceTrail> {
  const { productionBatchId, productionPlanId } = params;
  const events: BatchTrailEvent[] = [];
  const entityIds: string[] = [];

  const tempLogs = await db.collection(TEMPERATURE_LOGS_COLLECTION)
    .find(withTenantFilter(scopeAuth, { productionBatchId }))
    .sort({ recordedAt: 1 })
    .limit(200)
    .toArray() as unknown as TemperatureLogDoc[];
  for (const t of tempLogs) {
    entityIds.push(t.id);
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

  const qcList = productionPlanId
    ? await db.collection(QC_RESULTS_COLLECTION)
      .find(withTenantFilter(scopeAuth, { productionPlanId }))
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray() as unknown as QcResultDoc[]
    : [];
  for (const q of qcList) {
    entityIds.push(q.id);
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
    .find(withTenantFilter(scopeAuth, { productionBatchId }))
    .sort({ createdAt: 1 })
    .limit(100)
    .toArray() as unknown as HaccpResultDoc[];
  for (const h of haccpList) {
    entityIds.push(h.id);
    const firstPhoto = (h.evidenceUrls || [])[0];
    // ADR-004 P0B: sejak dokumen gagal boleh berstatus COMPLETED, status saja
    // menyesatkan bagi auditor — hasil pemeriksaan harus ikut tercetak.
    const disposition = effectiveHaccpDisposition(h);
    events.push({
      at: h.createdAt instanceof Date ? h.createdAt.toISOString() : String(h.tanggal),
      eventType: 'HACCP',
      entityType: 'haccp_result',
      entityId: h.id,
      refNo: h.noDokumen,
      summary: `HACCP ${h.noDokumen} (${h.templateKode || h.category}) · hasil ${HACCP_DISPOSITION_LABELS[disposition]} · foto ${h.summary?.photoCount || 0}`,
      statusOrAlert: h.status,
      evidenceUrl: firstPhoto,
      userName: h.createdByName,
    });
  }

  return { events, entityIds };
}

/** Same "open" lifecycle statuses used across Food Production docs (Plan/Issue/Result/QC). */
const QC_OPEN_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'PROCESSING'];

/**
 * Count of QC results not yet closed — used by food-dashboard.ts's "openQc" KPI tile.
 * Sprint 3 (docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md): second consumer moved off
 * QC_RESULTS_COLLECTION onto the Kitchen Assurance boundary.
 */
export async function countOpenQcResults(
  db: Db,
  scopeAuth: AuthContext | null | undefined,
): Promise<number> {
  return db.collection(QC_RESULTS_COLLECTION).countDocuments(
    withTenantFilter(scopeAuth, { status: { $in: QC_OPEN_STATUSES } }),
  );
}
