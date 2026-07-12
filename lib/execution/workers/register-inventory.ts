/**
 * Inventory domain handlers — EE-9C wave 1 + EE-9D wave 2 + EE-9E wave 3 wired.
 */

import { registerHandler } from '@/lib/execution/workers/registry';
import {
  executeAuditLogPurgeJob,
  executeCatalogSyncJob,
  executeGrnInvoiceSyncJob,
  executeGrnPostSideEffectsJob,
  executeGrnResolveProductsJob,
  executeGrnSyncShippedJob,
  executeHutangBackfillJob,
  executeHutangRepairJob,
  executeHutangSyncJob,
  executeIntegrationReconcileJob,
  executePoVendorSyncJob,
  executeSandboxResetJob,
  executeWebhookInboxJob,
} from '@/lib/api/inventory-execution-handlers';
import { assertExecutionHandlerSuccess } from '@/lib/api/execution-handler-result';

export function registerInventoryHandlers(): void {
  registerHandler<Record<string, unknown>>({
    type: 'WEBHOOK_INBOX',
    domain: 'inventory',
    classification: 'REALTIME',
    requiredCapabilities: ['WEBHOOK'],
    handler: async (ctx, payload) => assertExecutionHandlerSuccess(
      await executeWebhookInboxJob(ctx.db, payload),
    ),
  });

  registerHandler<Record<string, unknown>>({
    type: 'CATALOG_SYNC',
    domain: 'inventory',
    classification: 'IO_INTENSIVE',
    requiredCapabilities: ['CPU_BATCH'],
    handler: async (ctx) => assertExecutionHandlerSuccess(
      await executeCatalogSyncJob(ctx.db, ctx.tenantId, ctx.jobId),
    ),
  });

  registerHandler<Record<string, unknown>>({
    type: 'PO_VENDOR_SYNC',
    domain: 'inventory',
    classification: 'IO_INTENSIVE',
    requiredCapabilities: ['SYNC'],
    handler: async (ctx, payload) => assertExecutionHandlerSuccess(
      await executePoVendorSyncJob(ctx.db, ctx.tenantId, payload),
    ),
  });

  registerHandler<Record<string, unknown>>({
    type: 'HUTANG_SYNC',
    domain: 'inventory',
    classification: 'IO_INTENSIVE',
    requiredCapabilities: ['CPU_BATCH'],
    handler: async (ctx, payload) => assertExecutionHandlerSuccess(
      await executeHutangSyncJob(ctx.db, ctx.tenantId, payload),
    ),
  });

  registerHandler<Record<string, unknown>>({
    type: 'GRN_INVOICE_SYNC',
    domain: 'inventory',
    classification: 'IO_INTENSIVE',
    requiredCapabilities: ['SYNC'],
    requiresLock: true,
    lockTtlTier: 'NORMAL',
    lockKeyFromPayload: (payload, job) => (
      `grn-invoice:${job.tenantId}:${String(payload.grnId || job.id)}`
    ),
    handler: async (ctx, payload) => assertExecutionHandlerSuccess(
      await executeGrnInvoiceSyncJob(
        ctx.db,
        ctx.tenantId,
        String(payload.grnId || ''),
        payload,
      ),
    ),
  });

  registerHandler<Record<string, unknown>>({
    type: 'GRN_POST_SIDE_EFFECTS',
    domain: 'inventory',
    classification: 'IO_INTENSIVE',
    requiredCapabilities: ['CPU_BATCH'],
    requiresLock: true,
    lockTtlTier: 'SHORT',
    lockKeyFromPayload: (payload, job) => (
      `grn-sidefx:${job.tenantId}:${String(payload.grnId || job.id)}`
    ),
    handler: async (ctx, payload) => assertExecutionHandlerSuccess(
      await executeGrnPostSideEffectsJob(
        ctx.db,
        ctx.tenantId,
        String(payload.grnId || ''),
      ),
    ),
  });

  registerHandler<Record<string, unknown>>({
    type: 'GRN_SYNC_SHIPPED',
    domain: 'inventory',
    classification: 'IO_INTENSIVE',
    requiredCapabilities: ['CPU_BATCH'],
    handler: async (ctx) => assertExecutionHandlerSuccess(
      await executeGrnSyncShippedJob(ctx.db, ctx.tenantId),
    ),
  });

  registerHandler<Record<string, unknown>>({
    type: 'GRN_RESOLVE_PRODUCTS',
    domain: 'inventory',
    classification: 'IO_INTENSIVE',
    requiredCapabilities: ['CPU_BATCH'],
    handler: async (ctx) => assertExecutionHandlerSuccess(
      await executeGrnResolveProductsJob(ctx.db, ctx.tenantId),
    ),
  });

  registerHandler<Record<string, unknown>>({
    type: 'HUTANG_REPAIR',
    domain: 'inventory',
    classification: 'IO_INTENSIVE',
    requiredCapabilities: ['CPU_BATCH'],
    handler: async (ctx, payload) => assertExecutionHandlerSuccess(
      await executeHutangRepairJob(ctx.db, ctx.tenantId, payload),
    ),
  });

  registerHandler<Record<string, unknown>>({
    type: 'HUTANG_BACKFILL',
    domain: 'inventory',
    classification: 'BATCH',
    requiredCapabilities: ['CPU_BATCH'],
    handler: async (ctx) => assertExecutionHandlerSuccess(
      await executeHutangBackfillJob(ctx.db, ctx.tenantId),
    ),
  });

  registerHandler<Record<string, unknown>>({
    type: 'INTEGRATION_RECONCILE',
    domain: 'inventory',
    classification: 'BATCH',
    requiredCapabilities: ['CPU_BATCH'],
    handler: async (ctx, payload) => assertExecutionHandlerSuccess(
      await executeIntegrationReconcileJob(ctx.db, ctx.tenantId, payload),
    ),
  });

  registerHandler<Record<string, unknown>>({
    type: 'AUDIT_LOG_PURGE',
    domain: 'inventory',
    classification: 'BATCH',
    requiredCapabilities: ['MAINTENANCE'],
    handler: async (ctx) => assertExecutionHandlerSuccess(
      await executeAuditLogPurgeJob(ctx.db),
    ),
  });

  registerHandler<Record<string, unknown>>({
    type: 'SANDBOX_RESET',
    domain: 'inventory',
    classification: 'BATCH',
    requiredCapabilities: ['MAINTENANCE'],
    handler: async (ctx, payload) => assertExecutionHandlerSuccess(
      await executeSandboxResetJob(ctx.db, payload, ctx.jobId),
    ),
  });
}

registerInventoryHandlers();
