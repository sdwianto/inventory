import type { Db } from 'mongodb';
// Beritahu sales.app bahwa GRN sudah POSTED → auto-create & post invoice B2B + record hutang lokal.

import { getIntegrationConfig } from '@/lib/api/integration-config';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { createHutangFromVendorInvoice } from '@/lib/api/hutang-from-vendor';
import { syncCpoFromVendorEvent } from '@/lib/api/cpo-status-sync';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import { syncGrnDeliveryFromSales } from '@/lib/api/grn-delivery-sync';
import { salesFetchErrorMessage, integrationCorrelationId } from '@/lib/api/integration-common';
import { buildTraceHttpHeaders } from '@/lib/execution/tracing/trace-context';
import { recordIntegrationHold } from '@/lib/api/erp-hotpath-metrics';

function buildInvoicePayloadFromSales(data: Record<string, unknown>, grn: Record<string, unknown>) {
  if ((data.invoicePayload as Record<string, unknown> | undefined)?.invoiceId) {
    return data.invoicePayload as Record<string, unknown>;
  }

  const invoiceId = data.invoiceId || (data.invoicePayload as Record<string, unknown> | undefined)?.invoiceId;
  if (!invoiceId) return null;

  const invPayload = (data.invoicePayload || {}) as Record<string, unknown>;
  const total = parseInt(String(invPayload.total || data.total || grn.receivedTotal || 0), 10);
  const items = (grn.items as Array<Record<string, unknown>> | undefined) || [];
  return {
    invoiceId,
    noInvoice: data.noInvoice || invPayload.noInvoice,
    noDO: invPayload.noDO || grn.noDO,
    noPO: invPayload.noPO || grn.noPO || null,
    noSO: invPayload.noSO || grn.noSO || null,
    deliveryId: invPayload.deliveryId || null,
    salesOrderId: invPayload.salesOrderId || null,
    salesOrderTotal: parseInt(String(invPayload.salesOrderTotal || 0), 10) || null,
    salesOrderSubTotal: parseInt(String(invPayload.salesOrderSubTotal || 0), 10) || null,
    subTotal: parseInt(String(invPayload.subTotal || total), 10),
    ppn: parseInt(String(invPayload.ppn || 0), 10),
    total,
    paymentTerms: invPayload.paymentTerms || 'KREDIT',
    jatuhTempo: invPayload.jatuhTempo || null,
    items: invPayload.items || items.map((it) => ({
      lineId: it.lineId,
      kode: it.vendorKode || it.localKode,
      stokId: it.localStokId,
      qty: it.qtyReceived ?? it.qtyOrdered ?? 0,
      harga: it.harga || it.hargaSatuan || 0,
      uomId: it.uomId,
      satuan: it.satuan,
      qtyBase: it.qtyReceivedBase ?? it.qtyBase,
    })),
    postedAt: invPayload.postedAt || grn.postedAt || new Date(),
    pelangganName: invPayload.pelangganName || null,
    vendorTenantId: invPayload.vendorTenantId || data.vendorTenantId || null,
    vendorName: invPayload.vendorName || null,
    vendorCompanyName: invPayload.vendorCompanyName || null,
    vendorAddress: invPayload.vendorAddress || null,
    vendorPhone: invPayload.vendorPhone || null,
    vendorNPWP: invPayload.vendorNPWP || null,
    vendorLogoUrl: invPayload.vendorLogoUrl || invPayload.vendorLogoBase64 || null,
    vendor: invPayload.vendor || null,
  };
}

async function upsertHutangFromSalesPayload(
  db: Db,
  tenantId: string,
  data: Record<string, unknown>,
  grn: Record<string, unknown>,
  config: { vendorTenantId?: string },
) {
  const tid = normalizeTenantId(String(grn?.tenantId || tenantId));
  const payload = buildInvoicePayloadFromSales(data, grn);
  if (!payload?.invoiceId) {
    return { skipped: true, reason: 'no_invoice_payload' };
  }

  const vendorTenantId = data.vendorTenantId || grn.vendorTenantId || config.vendorTenantId;
  const result = await createHutangFromVendorInvoice(
    db,
    tid,
    payload,
    vendorTenantId ? String(vendorTenantId) : null,
    { createdVia: 'grn-posted' },
  );

  if ('error' in result && result.error) {
    return { error: result.error };
  }

  if (grn.id && payload.noInvoice) {
    await db.collection('goods_receipts').updateOne(
      { id: grn.id },
      {
        $set: {
          noInvoice: payload.noInvoice,
          vendorInvoiceId: payload.invoiceId,
          hutangId: result.hutangId || null,
          invoiceAutoPostedAt: new Date(),
        },
      },
    );
  }

  return {
    action: result.action,
    hutangId: result.hutangId,
    noHutang: result.noHutang,
    noInvoice: payload.noInvoice,
    approvalStatus: result.approvalStatus || 'PENDING_REVIEW',
  };
}

function tidFromGrn(grn: Record<string, unknown>) {
  return String(grn?.tenantId || 'sppg').trim().toLowerCase();
}

function buildFallbackDeliverySnapshot(grn: Record<string, unknown>) {
  const snap = grn.vendorDeliverySnapshot as Record<string, unknown> | undefined;
  if (snap?.deliveryId || (Array.isArray(snap?.items) && snap.items.length)) {
    const out = { ...snap };
    if (!out.customerTenantId) out.customerTenantId = tidFromGrn(grn);
    return out;
  }
  if (!grn?.vendorDeliveryId && !grn?.noDO) return null;
  const items = (grn.items as Array<Record<string, unknown>> | undefined) || [];
  return {
    deliveryId: grn.vendorDeliveryId || null,
    noDO: grn.noDO,
    noSO: grn.noSO,
    noPO: grn.noPO,
    vendorTenantId: grn.vendorTenantId,
    customerTenantId: tidFromGrn(grn),
    items: items.map((it) => ({
      lineId: it.lineId,
      kode: it.vendorKode || it.localKode,
      nama: it.vendorNama || it.localNama,
      qty: it.qtyOrdered ?? it.qtyReceived ?? 0,
      harga: it.harga || it.hargaSatuan || 0,
      satuan: it.satuan,
      uomId: it.uomId,
      qtyBase: it.qtyBase,
      factorToBase: it.factorToBase,
    })),
  };
}

function normalizeSalesGrnResponse(data: Record<string, unknown>) {
  if (data.invoiceId) return data;
  const result = (data.result || data) as Record<string, unknown>;
  if (result?.invoiceId) {
    return {
      ...result,
      invoicePayload: result.invoicePayload || result,
    };
  }
  return data;
}

function hasDeliverySnapshot(grn: Record<string, unknown>): boolean {
  const snap = grn.vendorDeliverySnapshot as Record<string, unknown> | undefined;
  const items = snap?.items;
  return Boolean(
    (grn.vendorDeliveryId || snap?.deliveryId)
    && Array.isArray(items)
    && items.length > 0,
  );
}

export async function notifyGrnPostedToSales(db: Db, tenantId: string, grn: Record<string, unknown>) {
  const tid = normalizeTenantId(String(grn?.tenantId || tenantId));
  const vendorId = grn?.vendorTenantId ? String(grn.vendorTenantId) : undefined;
  const salesApiKey = await getSalesApiKeyForVendor(db, tid, vendorId);
  if (!salesApiKey) {
    return { skipped: true, reason: 'not_paired' };
  }
  const config = await getIntegrationConfig(db, tid, vendorId);
  if (!grn?.noDO && !grn?.vendorDeliveryId) {
    return { skipped: true, reason: 'no_do_or_delivery_id' };
  }

  let currentGrn = grn as Record<string, unknown>;
  if (!hasDeliverySnapshot(currentGrn)) {
    const synced = await syncGrnDeliveryFromSales(db, tid, grn);
    currentGrn = (synced.grn || grn) as Record<string, unknown>;
  }

  const payload = {
    customerTenantId: tid,
    vendorTenantId: currentGrn.vendorTenantId || config.vendorTenantId,
    correlationId: integrationCorrelationId(null, String(currentGrn.noPO || '')),
    noDO: currentGrn.noDO,
    noSO: currentGrn.noSO || null,
    noGRN: currentGrn.noGRN,
    grnId: currentGrn.id,
    vendorDeliveryId: currentGrn.vendorDeliveryId || null,
    vendorDeliverySnapshot: buildFallbackDeliverySnapshot(currentGrn),
    noPO: currentGrn.noPO || null,
    postedAt: currentGrn.postedAt || new Date().toISOString(),
    receivedTotal: currentGrn.receivedTotal || 0,
    items: ((currentGrn.items as Array<Record<string, unknown>> | undefined) || []).map((it) => ({
      lineId: it.lineId,
      kode: it.vendorKode || it.localKode,
      stokId: it.localStokId,
      qty: it.qtyReceived ?? it.qtyOrdered ?? 0,
      harga: it.harga || it.hargaSatuan || 0,
      uomId: it.uomId,
      qtyBase: it.qtyReceivedBase ?? it.qtyBase,
      satuan: it.satuan,
    })),
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': salesApiKey,
    ...buildTraceHttpHeaders(),
  };
  const bodyJson = JSON.stringify(payload);
  const baseUrl = `${config.salesAppUrl}/api/integrations/grn-posted`;
  const holdStarted = Date.now();

  // Fast path: sync create+post+push invoice (biasanya <3s). Fallback async bila timeout/5xx.
  let res: Response;
  try {
    res = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: bodyJson,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // Timeout / offline → async enqueue (202) agar tidak gagal keras; hutang via invoice.posted.
    try {
      res = await fetch(`${baseUrl}?async=1`, {
        method: 'POST',
        headers,
        body: bodyJson,
        signal: AbortSignal.timeout(8_000),
      });
    } catch (e2) {
      recordIntegrationHold('inventory', 'grn_notify_sales', false, Date.now() - holdStarted);
      return { error: salesFetchErrorMessage(e2, config.salesAppUrl), offline: true };
    }
  }

  let data: Record<string, unknown>;
  try {
    data = await res.json() as Record<string, unknown>;
  } catch {
    recordIntegrationHold('inventory', 'grn_notify_sales', false, Date.now() - holdStarted);
    return { error: `Sales.app merespons HTTP ${res.status} tanpa JSON valid` };
  }

  // Sync gagal dengan 5xx → satu kali fallback async.
  if (!res.ok && res.status >= 500) {
    try {
      const asyncRes = await fetch(`${baseUrl}?async=1`, {
        method: 'POST',
        headers,
        body: bodyJson,
        signal: AbortSignal.timeout(8_000),
      });
      let asyncData: Record<string, unknown> = {};
      try {
        asyncData = await asyncRes.json() as Record<string, unknown>;
      } catch {
        asyncData = {};
      }
      if (asyncRes.status === 202 && asyncData.jobId) {
        recordIntegrationHold('inventory', 'grn_notify_sales', true, Date.now() - holdStarted);
        return { async: true, pending: true, salesJobId: asyncData.jobId };
      }
      res = asyncRes;
      data = asyncData;
    } catch {
      /* keep original error below */
    }
  }

  if (res.status === 202 && data.jobId) {
    recordIntegrationHold('inventory', 'grn_notify_sales', true, Date.now() - holdStarted);
    return {
      async: true,
      pending: true,
      salesJobId: data.jobId,
    };
  }

  if (!res.ok) {
    recordIntegrationHold('inventory', 'grn_notify_sales', false, Date.now() - holdStarted);
    const hint = data.draftNoInvoice
      ? ` — DRAFT ${data.draftNoInvoice} ada di sales.app, post manual jika perlu`
      : '';
    return { error: `${data.error || `Sales.app ${res.status}`}${hint}`, draftNoInvoice: data.draftNoInvoice };
  }

  recordIntegrationHold('inventory', 'grn_notify_sales', true, Date.now() - holdStarted);

  data = normalizeSalesGrnResponse(data);

  if (!data.invoiceId) {
    return { error: 'Sales.app tidak mengembalikan invoiceId — faktur tidak dibuat' };
  }

  const hutang = await upsertHutangFromSalesPayload(db, tid, data, currentGrn, config);

  if ('error' in hutang && hutang.error) {
    return {
      error: hutang.error,
      invoiceId: data.invoiceId,
      draftNoInvoice: data.draftNoInvoice,
      hutang,
    };
  }

  if (!('skipped' in hutang && hutang.skipped) && data.noInvoice && grn.noPO) {
    const invPayload = (data.invoicePayload || {}) as Record<string, unknown>;
    await syncCpoFromVendorEvent(db, tid, 'invoice.posted', {
      noPO: grn.noPO,
      noInvoice: data.noInvoice,
      invoiceId: data.invoiceId,
      total: invPayload.total || data.total || grn.receivedTotal,
      postedAt: invPayload.postedAt || grn.postedAt || new Date(),
    });
  }

  return {
    noInvoice: ('skipped' in hutang && hutang.skipped) || ('error' in hutang && hutang.error)
      ? null
      : (data.noInvoice || hutang.noInvoice),
    invoiceId: data.invoiceId,
    webhookSent: data.webhookSent,
    created: data.created,
    posted: data.posted,
    hutang,
  };
}
