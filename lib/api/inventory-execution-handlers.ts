/**
 * Wave-1/2 execution handlers — shared by legacy processJob and register-inventory.
 */

import type { Db } from 'mongodb';
import type { JsonObject } from '@/types/json';
import type { AuthContext } from '@/types/auth';
import { runCatalogSync } from '@/lib/api/catalog-sync-run';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { runHutangSyncPending } from '@/lib/api/hutang-sync-pending-run';
import { runPoVendorSyncPending } from '@/lib/api/po-vendor-sync-run';
import { processWebhookInboxEvent } from '@/lib/api/webhook-inbox-process';
import { runGrnInvoiceSyncJob } from '@/lib/api/bg-jobs';
import { runGrnPostSideEffects } from '@/lib/api/grn-post-side-effects-run';
import { runGrnSyncShipped } from '@/lib/api/grn-sync-shipped-run';
import { runHutangRepairJob } from '@/lib/api/hutang-repair-run';
import { runIntegrationReconcile } from '@/lib/api/integration-reconcile-run';
import { runAuditLogPurgeJob } from '@/lib/api/audit-purge-run';
import { runSandboxResetJob } from '@/lib/api/sandbox-purge';
import { getWorkerSandboxBlockReason } from '@/lib/api/sandbox-config';

export async function executeWebhookInboxJob(
  db: Db,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { event, payload: webhookPayload, customerTenantId, vendorTenantId, dedupeKey } = payload;
  if (!event || !webhookPayload || !customerTenantId) {
    return { error: 'Payload webhook tidak lengkap' };
  }

  let result: Record<string, unknown>;
  let status = 'PROCESSED';
  let processError: string | null = null;

  try {
    result = await processWebhookInboxEvent(db, {
      event: String(event),
      payload: webhookPayload as JsonObject,
      customerTenantId: String(customerTenantId),
      vendorTenantId: vendorTenantId ? String(vendorTenantId) : undefined,
    });
  } catch (e) {
    status = 'FAILED';
    processError = e instanceof Error ? e.message : String(e);
    result = { error: processError };
  }

  if (dedupeKey) {
    await db.collection('webhook_inbox').updateOne(
      { dedupeKey: String(dedupeKey) },
      {
        $set: {
          status,
          result,
          processError,
          processedAt: new Date(),
        },
      },
    );
  }

  if (status === 'FAILED') return { error: processError, result };
  return { ok: true, result };
}

export async function executeCatalogSyncJob(
  db: Db,
  tenantId: string,
  jobId?: string,
): Promise<Record<string, unknown>> {
  const config = await getIntegrationConfig(db, tenantId);
  if (!config.salesApiKey) return { error: 'Belum di-pair dengan sales.app' };
  const result = await runCatalogSync(db, tenantId, config, { jobId });
  if ('error' in result && result.error) {
    return { error: result.error, offline: Boolean(result.offline) };
  }
  return result as Record<string, unknown>;
}

export async function executeHutangSyncJob(
  db: Db,
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const replaySales = payload.replaySales === true;
  const scopeAuth = { tenantId } as AuthContext;
  return runHutangSyncPending(db, tenantId, scopeAuth, { replaySales });
}

export async function executePoVendorSyncJob(
  db: Db,
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const scopeAuth = { tenantId } as AuthContext;
  const poId = payload.poId ? String(payload.poId) : undefined;
  return runPoVendorSyncPending(db, scopeAuth, { poId });
}

export async function executeGrnInvoiceSyncJob(
  db: Db,
  tenantId: string,
  grnId: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (!grnId?.trim()) return { error: 'grnId wajib untuk GRN_INVOICE_SYNC' };
  return runGrnInvoiceSyncJob(db, {
    id: 'platform',
    type: 'GRN_INVOICE_SYNC',
    tenantId,
    grnId,
    payload: payload as JsonObject,
    status: 'RUNNING',
  });
}

export async function executeGrnPostSideEffectsJob(
  db: Db,
  tenantId: string,
  grnId: string,
): Promise<Record<string, unknown>> {
  if (!grnId?.trim()) return { error: 'grnId wajib untuk GRN_POST_SIDE_EFFECTS' };
  return runGrnPostSideEffects(db, tenantId, grnId);
}

export async function executeGrnSyncShippedJob(
  db: Db,
  tenantId: string,
): Promise<Record<string, unknown>> {
  return runGrnSyncShipped(db, tenantId);
}

export async function executeGrnResolveProductsJob(
  db: Db,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const { runGrnResolveProducts } = await import('@/lib/api/grn-resolve-products-run');
  return runGrnResolveProducts(db, tenantId);
}

export async function executeHutangRepairJob(
  db: Db,
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return runHutangRepairJob(db, { tenantId, payload: payload as JsonObject });
}

export async function executeHutangBackfillJob(
  db: Db,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const { backfillLegacyVendorInvoices } = await import('@/lib/api/migrate-hutang-approval');
  const { backfillHutangVarianceFields } = await import('@/lib/api/hutang-variance-enrich');
  const legacy = await backfillLegacyVendorInvoices(db, tenantId);
  const variance = await backfillHutangVarianceFields(db, tenantId);
  return { legacy, variance };
}

export async function executeIntegrationReconcileJob(
  db: Db,
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const allTenants = payload.allTenants === true;
  if (allTenants) {
    const tenants = await db.collection('tenants').find({}).project({ id: 1 }).toArray();
    if (tenants.length === 0) {
      return { ...(await runIntegrationReconcile(db, 'system')) };
    }
    const results: Record<string, unknown>[] = [];
    for (const t of tenants) {
      results.push({ ...(await runIntegrationReconcile(db, String(t.id))) });
    }
    return { tenants: results.length, results };
  }
  return { ...(await runIntegrationReconcile(db, tenantId)) };
}

export async function executeAuditLogPurgeJob(
  db: Db,
): Promise<Record<string, unknown>> {
  return runAuditLogPurgeJob(db);
}

export async function executeSandboxResetJob(
  db: Db,
  payload: Record<string, unknown>,
  jobId?: string,
): Promise<Record<string, unknown>> {
  const block = getWorkerSandboxBlockReason();
  if (block) return { error: block };

  return runSandboxResetJob(db, {
    tenantId: payload.tenantId ? String(payload.tenantId) : undefined,
    includeSales: payload.includeSales !== false,
    preserveJobId: jobId,
  });
}
