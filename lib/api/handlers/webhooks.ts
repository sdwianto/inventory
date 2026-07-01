import { v4 as uuidv4 } from 'uuid';
import type { JsonObject } from '@/types/json';
import type { HandlerContext } from '@/types/api/handler';
import type { VendorInvoicePayload } from '@/types/integration';
import { ok, err } from '@/lib/api/db';
import { verifyWebhookSecret } from '@/lib/api/webhook-verify';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import { createGrnFromDelivery } from '@/lib/api/grn-from-webhook';
import { upsertProductFromVendor, deactivateProductFromVendor } from '@/lib/api/product-sync';
import { createHutangFromVendorInvoice, applyCreditNoteFromVendor } from '@/lib/api/hutang-from-vendor';
import { syncCpoFromVendorEvent } from '@/lib/api/cpo-status-sync';

const PRODUCT_EVENTS = new Set(['product.created', 'product.updated', 'product.deactivated']);
const CPO_EVENTS = new Set(['sales_order.confirmed', 'delivery.shipped', 'invoice.posted']);

type WebhookBody = JsonObject & {
  event?: string;
  payload?: JsonObject;
  tenantId?: string;
};

function dedupeSourceId(event: string, payload: JsonObject): string | null {
  if (event === 'sales_order.confirmed') return String(payload.salesOrderId || '') || null;
  const product = payload.product as JsonObject | undefined;
  return String(
    payload.deliveryId || payload.invoiceId || payload.creditNoteId
    || (product ? `${product.id || product.kode}` : ''),
  ) || null;
}

export async function handleWebhooks({
  db,
  route,
  method,
  request,
  body,
}: HandlerContext) {
  const webhookBody = (body || {}) as WebhookBody;

  if (route !== '/webhooks/sales' || method !== 'POST') return null;

  const event = webhookBody.event || request.headers.get('x-event') || '';
  const payload = (webhookBody.payload || {}) as JsonObject;
  const vendorTenantIdFromEnvelope = webhookBody.tenantId ? String(webhookBody.tenantId) : undefined;

  const v = await verifyWebhookSecret(request, db, {
    customerTenantId: String(payload.customerTenantId || ''),
    vendorTenantId: vendorTenantIdFromEnvelope || String(payload.vendorTenantId || ''),
  });
  if (!v.ok) return err(v.error, 401);

  if (!event) return err('event wajib', 400);

  const tenantId = payload.customerTenantId;
  if (!tenantId) return err('customerTenantId wajib di payload', 400);

  const customerTenantId = String(tenantId).trim().toLowerCase();
  const vendorTenantId = vendorTenantIdFromEnvelope
    || (v.vendorTenantId ? String(v.vendorTenantId) : undefined);

  if (v.tenantId && normalizeTenantId(v.tenantId) !== customerTenantId) {
    return err('customerTenantId tidak cocok dengan webhook secret tenant', 403);
  }

  const sourceId = dedupeSourceId(event, payload);
  const dedupeKey = sourceId
    ? `${event}:${sourceId}:${customerTenantId}:${vendorTenantId || ''}`
    : `${event}:${uuidv4()}`;

  const existing = await db.collection('webhook_inbox').findOne({ dedupeKey });
  if (existing?.status === 'PROCESSED') {
    return ok({ message: 'already_processed', dedupeKey, result: existing.result });
  }

  const now = new Date();
  let result: Record<string, unknown> = {};
  let status = 'PROCESSED';
  let processError: string | null = null;

  try {
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
          ...(await deactivateProductFromVendor(db, customerTenantId, payload.product) || { action: 'skipped' }),
        };
      } else {
        result = {
          ...result,
          ...(await upsertProductFromVendor(db, customerTenantId, vendorTenantId, payload.product)),
        };
      }
    } else if (event === 'sales_order.confirmed') {
      if (!payload.salesOrderId) return err('salesOrderId wajib', 400);
      result = { ...result, message: 'so_confirmed', cpoStatus: (result.cpoSync as { status?: string })?.status };
    } else if (event === 'delivery.shipped') {
      if (!payload.deliveryId) return err('deliveryId wajib', 400);
      const grn = await createGrnFromDelivery(db, customerTenantId, payload, vendorTenantId);
      result = { ...result, grnId: grn?.id, noGRN: grn?.noGRN, cpoStatus: (result.cpoSync as { status?: string })?.status };
    } else if (event === 'invoice.posted') {
      if (!payload.invoiceId) return err('invoiceId wajib', 400);
      const hutang = await createHutangFromVendorInvoice(
        db,
        customerTenantId,
        payload as VendorInvoicePayload,
        vendorTenantId,
      );
      if ('error' in hutang && hutang.error) return err(hutang.error, 400);
      const fallbackMsg = hutang.action === 'exists'
        ? 'invoice.posted fallback — hutang sudah ada (primary grn-posted)'
        : 'invoice.posted fallback — hutang dibuat via webhook recovery';
      result = {
        ...result,
        ...hutang,
        fallback: true,
        message: fallbackMsg,
        cpoStatus: (result.cpoSync as { status?: string })?.status,
      };
    } else if (event === 'credit_note.posted') {
      if (!payload.invoiceId) return err('invoiceId wajib', 400);
      result = await applyCreditNoteFromVendor(
        db,
        customerTenantId,
        payload as VendorInvoicePayload,
        vendorTenantId,
      );
      if ('error' in result && result.error) return err(String(result.error), 400);
    } else if (!PRODUCT_EVENTS.has(event)) {
      return ok({ message: `event ${event} ignored` });
    }
  } catch (e) {
    status = 'FAILED';
    processError = e instanceof Error ? e.message : String(e);
    result = { error: processError };
  }

  if (existing) {
    await db.collection('webhook_inbox').updateOne(
      { dedupeKey },
      { $set: { status, result, processError, processedAt: now, retryCount: (existing.retryCount || 0) + 1 } },
    );
  } else {
    await db.collection('webhook_inbox').insertOne({
      id: uuidv4(),
      dedupeKey,
      event,
      tenantId: customerTenantId,
      vendorTenantId,
      payload,
      result,
      status,
      processError,
      processedAt: now,
      createdAt: now,
    });
  }

  if (status === 'FAILED') return err(processError || 'Gagal proses webhook', 500);
  return ok({ message: 'ok', event, result });
}
