import { v4 as uuidv4 } from 'uuid';
import type { JsonObject } from '@/types/json';
import type { HandlerContext } from '@/types/api/handler';
import { ok, err } from '@/lib/api/db';
import { verifyWebhookSecret } from '@/lib/api/webhook-verify';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import { enqueueJob, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';

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
  if (existing?.status === 'PENDING' || existing?.status === 'RUNNING') {
    return ok({ message: 'accepted', dedupeKey, async: true });
  }

  const now = new Date();
  if (!existing) {
    await db.collection('webhook_inbox').insertOne({
      id: uuidv4(),
      dedupeKey,
      event,
      tenantId: customerTenantId,
      vendorTenantId,
      payload,
      result: null,
      status: 'PENDING',
      processError: null,
      processedAt: null,
      createdAt: now,
    });
  } else {
    await db.collection('webhook_inbox').updateOne(
      { dedupeKey },
      { $set: { status: 'PENDING', processError: null, updatedAt: now } },
    );
  }

  const { jobId, reused } = await enqueueJob(db, {
    type: JOB_TYPES.WEBHOOK_INBOX,
    tenantId: customerTenantId,
    payload: {
      dedupeKey,
      event,
      payload,
      customerTenantId,
      vendorTenantId,
    },
  });
  scheduleJobProcessing(db);

  return ok({
    message: 'accepted',
    event,
    dedupeKey,
    jobId,
    async: true,
    reused,
  });
}
