/** Proses event webhook sales.app — dipanggil sync atau via bg_jobs. */

import type { Db } from 'mongodb';
import type { JsonObject } from '@/types/json';
import type { VendorInvoicePayload } from '@/types/integration';
import { createGrnFromDelivery } from '@/lib/api/grn-from-webhook';
import { upsertProductFromVendor, deactivateProductFromVendor } from '@/lib/api/product-sync';
import { createHutangFromVendorInvoice, applyCreditNoteFromVendor } from '@/lib/api/hutang-from-vendor';
import { syncCpoFromVendorEvent } from '@/lib/api/cpo-status-sync';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';

const PRODUCT_EVENTS = new Set(['product.created', 'product.updated', 'product.deactivated']);
const CPO_EVENTS = new Set(['sales_order.confirmed', 'delivery.shipped', 'invoice.posted']);

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
        ...(await deactivateProductFromVendor(db, customerTenantId, payload.product) || { action: 'skipped' }),
      };
    } else {
      result = {
        ...result,
        ...(await upsertProductFromVendor(db, customerTenantId, vendorTenantId, payload.product)),
      };
    }
    if (DASHBOARD_INVALIDATE_EVENTS.has(event)) {
      await invalidateDashboardSnapshot(db, customerTenantId);
    }
    return result;
  }

  if (event === 'sales_order.confirmed') {
    if (!payload.salesOrderId) throw new Error('salesOrderId wajib');
    await invalidateDashboardSnapshot(db, customerTenantId);
    return {
      ...result,
      message: 'so_confirmed',
      cpoStatus: (result.cpoSync as { status?: string })?.status,
    };
  }

  if (event === 'delivery.shipped') {
    if (!payload.deliveryId) throw new Error('deliveryId wajib');
    const grn = await createGrnFromDelivery(db, customerTenantId, payload, vendorTenantId);
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
    const hutang = await createHutangFromVendorInvoice(
      db,
      customerTenantId,
      payload as VendorInvoicePayload,
      vendorTenantId,
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
