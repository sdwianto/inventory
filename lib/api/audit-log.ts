// Centralized audit trail for stock & financial mutations.

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { txOpts } from '@/lib/api/transaction';
import { logger } from '@/lib/api/logger';
import type { AuthContext } from '@/types/auth';

export type AuditAction =
  | 'GRN_POSTED'
  | 'STOCK_ADJUSTMENT'
  | 'HUTANG_CREATED'
  | 'HUTANG_UPDATED'
  | 'STOCK_TRANSFER'
  | 'PUTAWAY_POST'
  | 'INVENTORY_RELEASE'
  | 'ASSET_CREATED'
  | 'ASSET_DELETED'
  | 'MAINTENANCE_WR_CREATED'
  | 'MAINTENANCE_WR_APPROVED'
  | 'MAINTENANCE_WR_CLOSED'
  | 'MAINTENANCE_SERVICE_CREATED'
  | 'MAINTENANCE_SCHEDULE_CREATED'
  | 'KITCHEN_CREATE'
  | 'KITCHEN_UPDATE'
  | 'KITCHEN_DEACTIVATE'
  | 'RECIPE_CREATE'
  | 'RECIPE_UPDATE'
  | 'RECIPE_DEACTIVATE'
  | 'RECIPE_DELETE'
  | 'RECIPE_IMPORT'
  | 'MENU_CREATE'
  | 'MENU_UPDATE'
  | 'MENU_DEACTIVATE'
  | 'MENU_DELETE'
  | 'PRODUCTION_PLAN_CREATE'
  | 'PRODUCTION_PLAN_UPDATE'
  | 'PRODUCTION_PLAN_STATUS'
  | 'PRODUCTION_PLAN_CANCEL'
  | 'PRODUCTION_PLAN_MATERIAL_OVERRIDE'
  | 'PRODUCTION_PLAN_RECIPE_BUFFER'
  | 'PORTION_TARGET_UPSERT'
  | 'PORTION_TARGET_UPDATE'
  | 'MRP_CREATE'
  | 'MRP_RECALCULATE'
  | 'MRP_REGENERATE'
  | 'MRP_STATUS'
  | 'MRP_CANCEL'
  | 'PR_CREATE'
  | 'PR_DRAFT_CPO'
  | 'PR_STATUS'
  | 'PR_CANCEL'
  | 'ISSUE_CREATE'
  | 'ISSUE_STATUS'
  | 'ISSUE_COMPLETE'
  | 'ISSUE_CANCEL'
  | 'RESULT_CREATE'
  | 'RESULT_STATUS'
  | 'RESULT_COMPLETE'
  | 'RESULT_CANCEL'
  | 'NUTRITION_UPSERT'
  | 'NUTRITION_APPLY_TKPI'
  | 'WAREHOUSE_BIN_CREATE'
  | 'WAREHOUSE_BIN_UPDATE'
  | 'WAREHOUSE_BIN_DEACTIVATE'
  | 'QC_TEMPLATE_CREATE'
  | 'QC_RESULT_CREATE'
  | 'QC_RESULT_RECORD'
  | 'QC_RESULT_STATUS'
  | 'QC_RESULT_COMPLETE'
  | 'QC_RESULT_CANCEL'
  | 'XFER_CREATE'
  | 'XFER_STATUS'
  | 'XFER_COMPLETE'
  | 'XFER_CANCEL'
  | 'SERVICE_POINT_CREATE'
  | 'SERVICE_POINT_UPDATE'
  | 'SERVICE_POINT_DEACTIVATE'
  | 'SERVICE_POINT_DELETE'
  | 'ARMADA_CREATE'
  | 'ARMADA_UPDATE'
  | 'ARMADA_DEACTIVATE'
  | 'DIST_CREATE'
  | 'DIST_STATUS'
  | 'DIST_SCHEDULE'
  | 'DIST_COMPLETE'
  | 'DIST_CANCEL'
  | 'TEMP_LOG_CREATE'
  | 'TEMP_LOG_ALERT'
  | 'TEMP_LOG_ACK'
  | 'TEMP_THRESHOLD_UPSERT'
  | 'HACCP_TEMPLATE_CREATE'
  | 'HACCP_RESULT_CREATE'
  | 'HACCP_RESULT_UPDATE'
  | 'HACCP_RESULT_STATUS'
  | 'HACCP_RESULT_COMPLETE'
  | 'HACCP_RESULT_CANCEL'
  | 'SUPPLIER_PRICE_BOOK_UPSERT'
  | 'SUPPLIER_PRICE_BOOK_DEACTIVATE'
  | 'SUPPLIER_PRICE_BOOK_SYNC_INVOICE'
  | 'API_KEY_CREATE'
  | 'API_KEY_REVOKE'
  | 'KA_POLICY_CREATE'
  | 'KA_POLICY_UPDATE'
  | 'KA_MONITORING_DEF_CREATE'
  | 'KA_MONITORING_DEF_UPDATE'
  | 'KA_MONITORING_APPLY'
  | 'KA_OBSERVATION_CREATE'
  | 'KA_OBSERVATION_STATUS'
  | 'KA_CASE_CREATE'
  | 'KA_CASE_UPDATE'
  | 'KA_FOLLOW_UP_CREATE'
  | 'KA_FOLLOW_UP_STATUS';

export interface AuditLogEntry {
  tenantId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  summary: string;
  metadata?: Record<string, unknown>;
  userId?: string;
  userName?: string;
}

const AUDIT_UI_RETENTION_DAYS = 90;
/** Retensi compliance — ~7 tahun (P3). */
export const AUDIT_COMPLIANCE_RETENTION_DAYS = 2555;
export { AUDIT_UI_RETENTION_DAYS };

export function auditUiRetentionCutoff(): Date {
  const d = new Date();
  d.setDate(d.getDate() - AUDIT_UI_RETENTION_DAYS);
  return d;
}

export function auditCompliancePurgeCutoff(): Date {
  const d = new Date();
  d.setDate(d.getDate() - AUDIT_COMPLIANCE_RETENTION_DAYS);
  return d;
}

/** Default baca UI — 90 hari. Gunakan `scope=compliance` untuk jendela 7 tahun. */
export function auditRetentionCutoff(): Date {
  return auditUiRetentionCutoff();
}

export function auditReadCutoff(scope: 'ui' | 'compliance'): Date {
  return scope === 'compliance' ? auditCompliancePurgeCutoff() : auditUiRetentionCutoff();
}

export async function writeAuditLog(
  db: Db,
  entry: AuditLogEntry,
  session?: ClientSession,
): Promise<void> {
  const doc = {
    id: uuidv4(),
    ...entry,
    createdAt: new Date(),
  };
  try {
    await db.collection('audit_log').insertOne(doc, txOpts(session));
  } catch (e) {
    logger.warn('audit_log insert failed', {
      action: entry.action,
      entityId: entry.entityId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export function auditActor(auth?: AuthContext | null): Pick<AuditLogEntry, 'userId' | 'userName'> {
  return {
    userId: auth?.userId || 'system',
    userName: auth?.name || auth?.email || 'System',
  };
}
