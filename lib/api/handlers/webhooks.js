import { v4 as uuidv4 } from 'uuid';

import { ok, err, clean } from '@/lib/api/db';

import { verifyWebhookSecret } from '@/lib/api/webhook-verify';

import { createGrnFromDelivery } from '@/lib/api/grn-from-webhook';

import { upsertProductFromVendor, deactivateProductFromVendor } from '@/lib/api/product-sync';

import { createHutangFromVendorInvoice, applyCreditNoteFromVendor } from '@/lib/api/hutang-from-vendor';



const PRODUCT_EVENTS = new Set(['product.created', 'product.updated', 'product.deactivated']);



export async function handleWebhooks({ db, route, method, request, body }) {

  if (route !== '/webhooks/sales' || method !== 'POST') return null;



  const v = await verifyWebhookSecret(request, db);

  if (!v.ok) return err(v.error, 401);



  const event = body?.event || request.headers.get('x-event') || '';

  const payload = body?.payload || {};

  if (!event) return err('event wajib', 400);



  const tenantId = payload.customerTenantId;

  if (!tenantId) return err('customerTenantId wajib di payload', 400);



  const sourceId = payload.deliveryId || payload.invoiceId || payload.creditNoteId

    || (payload.product ? `${payload.product.id || payload.product.kode}` : null);

  const dedupeKey = sourceId ? `${event}:${sourceId}:${tenantId}` : `${event}:${uuidv4()}`;



  const existing = await db.collection('webhook_inbox').findOne({ dedupeKey });

  if (existing?.status === 'PROCESSED') {

    return ok({ message: 'already_processed', dedupeKey, result: existing.result });

  }



  const now = new Date();

  let result = {};

  let status = 'PROCESSED';

  let processError = null;



  try {

    if (PRODUCT_EVENTS.has(event) && payload.product) {

      if (event === 'product.deactivated') {

        result = await deactivateProductFromVendor(db, tenantId, payload.product) || { action: 'skipped' };

      } else {

        result = await upsertProductFromVendor(db, tenantId, body?.tenantId, payload.product);

      }

    } else if (event === 'delivery.shipped') {

      if (!payload.deliveryId) return err('deliveryId wajib', 400);

      const grn = await createGrnFromDelivery(db, tenantId, payload, body?.tenantId);

      result = { grnId: grn?.id, noGRN: grn?.noGRN };

    } else if (event === 'invoice.posted') {

      if (!payload.invoiceId) return err('invoiceId wajib', 400);

      result = await createHutangFromVendorInvoice(db, tenantId, payload, body?.tenantId);

      if (result.error) return err(result.error, 400);

    } else if (event === 'credit_note.posted') {

      if (!payload.invoiceId) return err('invoiceId wajib', 400);

      result = await applyCreditNoteFromVendor(db, tenantId, payload, body?.tenantId);

      if (result.error) return err(result.error, 400);

    } else {

      return ok({ message: `event ${event} ignored` });

    }

  } catch (e) {

    status = 'FAILED';

    processError = e.message;

    result = { error: e.message };

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

      tenantId,

      vendorTenantId: body?.tenantId,

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

