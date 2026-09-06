/** Inbound integrasi dari sales.app — sinkron seperti POST /integrations/customer-po. */

import type { HandlerContext } from '@/types/api/handler';
import type { JsonObject } from '@/types/json';
import type { VendorInvoicePayload } from '@/types/integration';
import { ok, err, clean } from '@/lib/api/db';
import { verifyWebhookSecret } from '@/lib/api/webhook-verify';
import { createGrnFromDelivery } from '@/lib/api/grn-from-webhook';
import { syncCpoFromVendorEvent } from '@/lib/api/cpo-status-sync';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import {
  applyCreditNoteFromVendor,
  createHutangFromVendorInvoice,
} from '@/lib/api/hutang-from-vendor';
import { applyVendorReturnDecision, type VendorReturnLineDecisionInput } from '@/lib/api/vendor-return-decision';

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

    // Contract Spec Category A (P2): headers wajib.
    const idemKey = String(request.headers.get('idempotency-key') || '').trim();
    const correlationId = String(request.headers.get('x-correlation-id') || '').trim();
    if (!idemKey || !correlationId) {
      return err('Idempotency-Key dan X-Correlation-Id wajib untuk Category A (delivery-shipped)', 400);
    }

    const v = await verifyWebhookSecret(request, db, {
      customerTenantId,
      vendorTenantId: vendorTenantId || undefined,
    });
    if (!v.ok) return err(v.error, 401);

    if (!customerTenantId) return err('customerTenantId wajib', 400);
    if (!payload.deliveryId) return err('deliveryId wajib', 400);

    const vid = vendorTenantId || v.vendorTenantId || '';

    const existingBefore = payload.deliveryId
      ? await db.collection('goods_receipts').findOne({
        tenantId: customerTenantId,
        vendorDeliveryId: payload.deliveryId,
      })
      : null;

    const grn = await createGrnFromDelivery(db, customerTenantId, payload, vid || null, {
      correlationId,
    });
    const existingAfter = payload.deliveryId
      ? await db.collection('goods_receipts').findOne({
        tenantId: customerTenantId,
        vendorDeliveryId: String(payload.deliveryId),
      })
      : null;
    const created = !existingBefore && !!grn?.id;
    const cpoSync = await syncCpoFromVendorEvent(db, customerTenantId, 'delivery.shipped', {
      ...payload,
      vendorTenantId: vid,
    });
    await invalidateDashboardSnapshot(db, customerTenantId);

    // Contract Spec P2: minimum fields + backward-compat.
    return ok(clean({
      ...grn,
      grnId: grn.id,
      noGRN: grn.noGRN,
      status: grn.status,
      created,
      existing: !!existingBefore || (!!existingAfter && !created),
      vendorTenantId: vid || null,
      customerTenantId,
      deliveryId: payload.deliveryId,
      correlationId,
      idempotencyKey: idemKey,
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

    // W1-3: CID wajib untuk ops spine hutang (align Category A header discipline).
    const correlationId = String(
      request.headers.get('x-correlation-id')
      || payload.correlationId
      || '',
    ).trim();
    if (!correlationId) {
      return err('X-Correlation-Id wajib untuk invoice-posted', 400);
    }

    const v = await verifyWebhookSecret(request, db, {
      customerTenantId,
      vendorTenantId: vendorTenantId || undefined,
    });
    if (!v.ok) return err(v.error, 401);

    if (!customerTenantId) return err('customerTenantId wajib', 400);
    if (!payload.invoiceId) return err('invoiceId wajib', 400);

    const vid = vendorTenantId || v.vendorTenantId || '';
    const { startIntegrationCommand, finishIntegrationCommand } = await import(
      '@/lib/integration/command-log'
    );
    const commandId = await startIntegrationCommand(db, {
      correlationId,
      commandType: 'ReceiveInvoicePosted',
      invoiceId: String(payload.invoiceId),
    });

    try {
      const hutang = await createHutangFromVendorInvoice(
        db,
        customerTenantId,
        payload as VendorInvoicePayload,
        vid || null,
        { createdVia: 'invoice-posted-push', correlationId },
      );
      if ('error' in hutang && hutang.error) {
        await finishIntegrationCommand(db, commandId, {
          status: 'FAILED',
          invoiceId: String(payload.invoiceId),
          errorCode: 'HUTANG_CREATE_FAILED',
          errorMessage: String(hutang.error),
          errorClass: 'validation',
          httpStatus: 400,
        });
        return err(String(hutang.error), 400);
      }

      await finishIntegrationCommand(db, commandId, {
        status: 'SUCCEEDED',
        invoiceId: String(payload.invoiceId),
        apId: hutang.hutangId ? String(hutang.hutangId) : null,
      });

      const cpoSync = await syncCpoFromVendorEvent(db, customerTenantId, 'invoice.posted', {
        ...payload,
        vendorTenantId: vid,
      });
      await invalidateDashboardSnapshot(db, customerTenantId);

      return ok(clean({
        ...hutang,
        cpoSync,
        correlationId,
        message: 'hutang via invoice-posted push',
      }));
    } catch (e) {
      await finishIntegrationCommand(db, commandId, {
        status: 'FAILED',
        invoiceId: String(payload.invoiceId),
        errorCode: 'HUTANG_CREATE_FAILED',
        errorMessage: e instanceof Error ? e.message : String(e),
        errorClass: 'unknown',
      });
      throw e;
    }
  }

  // Category B: credit note.posted → apply CN ke hutang (mirror invoice-posted).
  if (route === '/integrations/credit-note-posted') {
    const payload = (body || {}) as JsonObject;
    const customerTenantId = String(payload.customerTenantId || '').trim().toLowerCase();
    const vendorTenantId = String(
      payload.vendorTenantId
      || request.headers.get('x-vendor-tenant-id')
      || '',
    ).trim();

    const correlationId = String(
      request.headers.get('x-correlation-id')
      || payload.correlationId
      || '',
    ).trim();
    if (!correlationId) {
      return err('X-Correlation-Id wajib untuk credit-note-posted', 400);
    }

    const v = await verifyWebhookSecret(request, db, {
      customerTenantId,
      vendorTenantId: vendorTenantId || undefined,
    });
    if (!v.ok) return err(v.error, 401);

    if (!customerTenantId) return err('customerTenantId wajib', 400);
    if (!payload.invoiceId) return err('invoiceId wajib', 400);

    const vid = vendorTenantId || v.vendorTenantId || '';
    const creditNoteId = String(payload.creditNoteId || '').trim();
    const { startIntegrationCommand, finishIntegrationCommand } = await import(
      '@/lib/integration/command-log'
    );
    const commandId = await startIntegrationCommand(db, {
      correlationId,
      commandType: 'ReceiveCreditNotePosted',
      invoiceId: String(payload.invoiceId),
      creditNoteId: creditNoteId || null,
    });

    try {
      const cn = await applyCreditNoteFromVendor(
        db,
        customerTenantId,
        payload as VendorInvoicePayload & { creditNoteId?: string; noCN?: string },
        vid || null,
        { appliedVia: 'credit-note-posted-push', correlationId },
      );
      if ('error' in cn && cn.error) {
        await finishIntegrationCommand(db, commandId, {
          status: 'FAILED',
          invoiceId: String(payload.invoiceId),
          creditNoteId: creditNoteId || null,
          errorCode: 'CREDIT_NOTE_APPLY_FAILED',
          errorMessage: String(cn.error),
          errorClass: 'validation',
          httpStatus: 400,
        });
        return err(String(cn.error), 400);
      }

      await finishIntegrationCommand(db, commandId, {
        status: 'SUCCEEDED',
        invoiceId: String(payload.invoiceId),
        creditNoteId: creditNoteId || null,
        apId: cn.hutangId ? String(cn.hutangId) : null,
      });

      await invalidateDashboardSnapshot(db, customerTenantId);

      return ok(clean({
        ...cn,
        correlationId,
        message: 'credit note via credit-note-posted push',
      }));
    } catch (e) {
      await finishIntegrationCommand(db, commandId, {
        status: 'FAILED',
        invoiceId: String(payload.invoiceId),
        creditNoteId: creditNoteId || null,
        errorCode: 'CREDIT_NOTE_APPLY_FAILED',
        errorMessage: e instanceof Error ? e.message : String(e),
        errorClass: 'unknown',
      });
      throw e;
    }
  }

  // ADR-006 (Category B): keputusan vendor per baris (Terima/Tolak) → stempel RTV.
  if (route === '/integrations/vendor-return-decision') {
    const payload = (body || {}) as JsonObject;
    const customerTenantId = String(payload.customerTenantId || '').trim().toLowerCase();
    const vendorTenantId = String(
      payload.vendorTenantId
      || request.headers.get('x-vendor-tenant-id')
      || '',
    ).trim();

    const correlationId = String(
      request.headers.get('x-correlation-id')
      || payload.correlationId
      || '',
    ).trim();
    if (!correlationId) {
      return err('X-Correlation-Id wajib untuk vendor-return-decision', 400);
    }

    const v = await verifyWebhookSecret(request, db, {
      customerTenantId,
      vendorTenantId: vendorTenantId || undefined,
    });
    if (!v.ok) return err(v.error, 401);

    if (!customerTenantId) return err('customerTenantId wajib', 400);
    const returnId = String(payload.returnId || '').trim();
    if (!returnId) return err('returnId wajib', 400);

    const rawDecisions = Array.isArray(payload.lineDecisions) ? payload.lineDecisions : [];
    if (!rawDecisions.length) return err('lineDecisions wajib minimal 1 baris', 400);
    const lineDecisions: VendorReturnLineDecisionInput[] = [];
    for (const raw of rawDecisions) {
      const row = (raw || {}) as JsonObject;
      // Wire field = lineId (konvensi sama seperti items[].lineId di goods-return-posted).
      const lineId = String(row.lineId || '').trim();
      const decision = String(row.decision || '').trim();
      if (!lineId || (decision !== 'ACCEPTED' && decision !== 'REJECTED')) {
        return err('Tiap lineDecisions wajib lineId + decision ACCEPTED/REJECTED', 400);
      }
      const reason = String(row.reason || '').trim();
      if (decision === 'REJECTED' && !reason) {
        return err(`Baris ${lineId} ditolak wajib alasan`, 400);
      }
      lineDecisions.push({ lineId, decision, reason: reason || undefined });
    }

    const creditNoteId = String(payload.creditNoteId || '').trim();
    const { startIntegrationCommand, finishIntegrationCommand } = await import(
      '@/lib/integration/command-log'
    );
    const commandId = await startIntegrationCommand(db, {
      correlationId,
      commandType: 'ReceiveVendorReturnDecision',
      grnId: returnId || null,
      creditNoteId: creditNoteId || null,
    });

    try {
      const result = await applyVendorReturnDecision(db, customerTenantId, {
        returnId,
        creditNoteId: creditNoteId || undefined,
        lineDecisions,
        decidedBy: (payload.decidedBy as { userId?: string; userName?: string } | undefined) || undefined,
      });
      if ('error' in result) {
        await finishIntegrationCommand(db, commandId, {
          status: 'FAILED',
          creditNoteId: creditNoteId || null,
          errorCode: result.code || 'VENDOR_RETURN_DECISION_FAILED',
          errorMessage: result.error,
          errorClass: 'validation',
          httpStatus: result.status,
        });
        return err(result.error, result.status);
      }

      await finishIntegrationCommand(db, commandId, {
        status: 'SUCCEEDED',
        creditNoteId: creditNoteId || null,
      });

      return ok(clean({ ...result, correlationId }));
    } catch (e) {
      await finishIntegrationCommand(db, commandId, {
        status: 'FAILED',
        creditNoteId: creditNoteId || null,
        errorCode: 'VENDOR_RETURN_DECISION_FAILED',
        errorMessage: e instanceof Error ? e.message : String(e),
        errorClass: 'unknown',
      });
      throw e;
    }
  }

  return null;
}
