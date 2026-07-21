/** Inbound integrasi dari sales.app — sinkron seperti POST /integrations/customer-po. */

import type { HandlerContext } from '@/types/api/handler';
import type { JsonObject } from '@/types/json';
import type { VendorInvoicePayload } from '@/types/integration';
import { ok, err, clean } from '@/lib/api/db';
import { verifyWebhookSecret } from '@/lib/api/webhook-verify';
import { createGrnFromDelivery } from '@/lib/api/grn-from-webhook';
import { syncCpoFromVendorEvent } from '@/lib/api/cpo-status-sync';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import { createHutangFromVendorInvoice } from '@/lib/api/hutang-from-vendor';

export async function handleIntegrationInbound({
  db,
  route,
  method,
  body,
  request,
}: HandlerContext) {
  if (method !== 'POST') return null;

  if (route === '/integrations/delivery-shipped') {
    const payload = (body || {}) as JsonObject;
    const customerTenantId = String(payload.customerTenantId || '').trim().toLowerCase();
    const vendorTenantId = String(
      payload.vendorTenantId
      || request.headers.get('x-vendor-tenant-id')
      || '',
    ).trim();

    const v = await verifyWebhookSecret(request, db, {
      customerTenantId,
      vendorTenantId: vendorTenantId || undefined,
    });
    if (!v.ok) return err(v.error, 401);

    if (!customerTenantId) return err('customerTenantId wajib', 400);
    if (!payload.deliveryId) return err('deliveryId wajib', 400);

    const vid = vendorTenantId || v.vendorTenantId || '';

    const existing = payload.deliveryId
      ? await db.collection('goods_receipts').findOne({
        tenantId: customerTenantId,
        vendorDeliveryId: payload.deliveryId,
      })
      : null;

    const grn = await createGrnFromDelivery(db, customerTenantId, payload, vid || null);
    const cpoSync = await syncCpoFromVendorEvent(db, customerTenantId, 'delivery.shipped', {
      ...payload,
      vendorTenantId: vid,
    });
    await invalidateDashboardSnapshot(db, customerTenantId);

    return ok(clean({
      ...grn,
      grnId: grn.id,
      noGRN: grn.noGRN,
      created: !existing,
      cpoSync,
    }));
  }

  // Primary hutang path dari Sales setelah GRN→invoice (mirror delivery-shipped).
  if (route === '/integrations/invoice-posted') {
    const payload = (body || {}) as JsonObject;
    const customerTenantId = String(payload.customerTenantId || '').trim().toLowerCase();
    const vendorTenantId = String(
      payload.vendorTenantId
      || request.headers.get('x-vendor-tenant-id')
      || '',
    ).trim();

    const v = await verifyWebhookSecret(request, db, {
      customerTenantId,
      vendorTenantId: vendorTenantId || undefined,
    });
    if (!v.ok) return err(v.error, 401);

    if (!customerTenantId) return err('customerTenantId wajib', 400);
    if (!payload.invoiceId) return err('invoiceId wajib', 400);

    const vid = vendorTenantId || v.vendorTenantId || '';
    const hutang = await createHutangFromVendorInvoice(
      db,
      customerTenantId,
      payload as VendorInvoicePayload,
      vid || null,
      { createdVia: 'invoice-posted-push' },
    );
    if ('error' in hutang && hutang.error) return err(String(hutang.error), 400);

    const cpoSync = await syncCpoFromVendorEvent(db, customerTenantId, 'invoice.posted', {
      ...payload,
      vendorTenantId: vid,
    });
    await invalidateDashboardSnapshot(db, customerTenantId);

    return ok(clean({
      ...hutang,
      cpoSync,
      message: 'hutang via invoice-posted push',
    }));
  }

  return null;
}
