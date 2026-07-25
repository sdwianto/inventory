/** Proses event webhook sales.app — dipanggil sync atau via bg_jobs. */

import type { Db } from 'mongodb';
import type { JsonObject } from '@/types/json';
import type { VendorInvoicePayload } from '@/types/integration';
import { createGrnFromDelivery } from '@/lib/api/grn-from-webhook';
import { upsertProductFromVendor, deactivateProductFromVendor } from '@/lib/api/product-sync';
import { createHutangFromVendorInvoice, applyCreditNoteFromVendor, hutangAlreadyFromGrnPrimaryPath } from '@/lib/api/hutang-from-vendor';
import { syncCpoFromVendorEvent } from '@/lib/api/cpo-status-sync';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';

const PRODUCT_EVENTS = new Set(['product.created', 'product.updated', 'product.deactivated']);
const CPO_EVENTS = new Set(['sales_order.confirmed', 'sales_order.updated', 'sales_order.cancelled', 'delivery.shipped', 'invoice.posted']);

const DASHBOARD_INVALIDATE_EVENTS = new Set([
  ...PRODUCT_EVENTS,
  ...CPO_EVENTS,
  'credit_note.posted',
]);

export interface WebhookProcessInput {
  event: string;
  payload: JsonObject;
  customerTenantId: string;
  vendorTenantId?: string;
}

/** Event yang diproses sinkron — hanya non-VPS untuk delivery fallback. */
export function shouldProcessWebhookInline(event: string): boolean {
  // VPS: semua event via WEBHOOK_INBOX job (worker) — jangan blok HTTP webhook sales.
  if (process.env.DEPLOYMENT_MODE === 'vps') {
    return false;
  }
  // Serverless / CI: delivery.shipped inline jika tanpa worker; confirmed tetap async.
  if (event === 'delivery.shipped') {
    return true;
  }
  return false;
}

/** @deprecated use shouldProcessWebhookInline — kept for imports */
export const INLINE_WEBHOOK_EVENTS = new Set(['delivery.shipped']);

export async function runWebhookInboxInline(
  db: Db,
  input: WebhookProcessInput & { dedupeKey: string },
): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; result: Record<string, unknown> }
> {
  const { dedupeKey, ...processInput } = input;
  await db.collection('webhook_inbox').updateOne(
    { dedupeKey },
    { $set: { status: 'RUNNING', updatedAt: new Date() } },
  );

  try {
    const result = await processWebhookInboxEvent(db, processInput);
    await db.collection('webhook_inbox').updateOne(
      { dedupeKey },
      {
        $set: {
          status: 'PROCESSED',
          result,
          processError: null,
          processedAt: new Date(),
        },
      },
    );
    return { ok: true, result };
  } catch (e) {
    const processError = e instanceof Error ? e.message : String(e);
    const result = { error: processError };
    await db.collection('webhook_inbox').updateOne(
      { dedupeKey },
      {
        $set: {
          status: 'FAILED',
          result,
          processError,
          processedAt: new Date(),
        },
      },
    );
    return { ok: false, error: processError, result };
  }
}

export async function processWebhookInboxEvent(
  db: Db,
  { event, payload, customerTenantId, vendorTenantId }: WebhookProcessInput,
): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> = {};

  if (CPO_EVENTS.has(event)) {
    const cpoSync = await syncCpoFromVendorEvent(db, customerTenantId, event, {
      ...payload,
      vendorTenantId,
    });
    result.cpoSync = cpoSync;
  }

  if (PRODUCT_EVENTS.has(event) && payload.product) {
    if (event === 'product.deactivated') {
      result = {
        ...result,
        ...(await deactivateProductFromVendor(db, customerTenantId, payload.product as Record<string, unknown>) || { action: 'skipped' }),
      };
    } else {
      result = {
        ...result,
        ...(await upsertProductFromVendor(db, customerTenantId, vendorTenantId, payload.product as Record<string, unknown>)),
      };
    }
    if (DASHBOARD_INVALIDATE_EVENTS.has(event)) {
      await invalidateDashboardSnapshot(db, customerTenantId);
    }
    return result;
  }

  if (event === 'sales_order.confirmed' || event === 'sales_order.updated') {
    if (!payload.salesOrderId) throw new Error('salesOrderId wajib');
    await invalidateDashboardSnapshot(db, customerTenantId);
    return {
      ...result,
      message: event === 'sales_order.updated' ? 'so_updated' : 'so_confirmed',
      cpoStatus: (result.cpoSync as { status?: string })?.status,
    };
  }

  if (event === 'delivery.shipped') {
    if (!payload.deliveryId) throw new Error('deliveryId wajib');
    const grn = await createGrnFromDelivery(db, customerTenantId, payload, vendorTenantId, {
      correlationId: payload.correlationId ? String(payload.correlationId) : null,
    });
    await invalidateDashboardSnapshot(db, customerTenantId);
    return {
      ...result,
      grnId: grn?.id,
      noGRN: grn?.noGRN,
      cpoStatus: (result.cpoSync as { status?: string })?.status,
    };
  }

  if (event === 'invoice.posted') {
    if (!payload.invoiceId) throw new Error('invoiceId wajib');
    const existingPrimary = await hutangAlreadyFromGrnPrimaryPath(
      db,
      customerTenantId,
      payload as VendorInvoicePayload,
      vendorTenantId,
    );
    if (existingPrimary?.skippedWebhook) {
      await invalidateDashboardSnapshot(db, customerTenantId);
      return {
        ...result,
        ...existingPrimary,
        fallback: true,
        message: 'invoice.posted skipped — hutang sudah dari grn-posted',
        cpoStatus: (result.cpoSync as { status?: string })?.status,
      };
    }
    const hutang = await createHutangFromVendorInvoice(
      db,
      customerTenantId,
      payload as VendorInvoicePayload,
      vendorTenantId,
      {
        createdVia: 'invoice-posted-webhook',
        correlationId: payload.correlationId ? String(payload.correlationId) : null,
      },
    );
    if ('error' in hutang && hutang.error) throw new Error(String(hutang.error));
    await invalidateDashboardSnapshot(db, customerTenantId);
    return {
      ...result,
      ...hutang,
      fallback: true,
      message: hutang.action === 'exists'
        ? 'invoice.posted fallback — hutang sudah ada'
        : 'invoice.posted fallback — hutang dibuat via webhook recovery',
      cpoStatus: (result.cpoSync as { status?: string })?.status,
    };
  }

  if (event === 'credit_note.posted') {
    if (!payload.invoiceId) throw new Error('invoiceId wajib');
    const cn = await applyCreditNoteFromVendor(
      db,
      customerTenantId,
      payload as VendorInvoicePayload,
      vendorTenantId,
    );
    if ('error' in cn && cn.error) throw new Error(String(cn.error));
    await invalidateDashboardSnapshot(db, customerTenantId);
    return cn as Record<string, unknown>;
  }

  return { message: `event ${event} ignored` };
}
