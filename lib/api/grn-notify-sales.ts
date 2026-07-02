import type { Db } from 'mongodb';
// Beritahu sales.app bahwa GRN sudah POSTED → auto-create & post invoice B2B + record hutang lokal.

import { getIntegrationConfig } from '@/lib/api/integration-config';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { createHutangFromVendorInvoice } from '@/lib/api/hutang-from-vendor';
import { syncCpoFromVendorEvent } from '@/lib/api/cpo-status-sync';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import { syncGrnDeliveryFromSales } from '@/lib/api/grn-delivery-sync';

function salesFetchErrorMessage(err: unknown, salesUrl: string) {
  const e = err as { cause?: { code?: string }; code?: string; name?: string; message?: string };
  const cause = e?.cause;
  const code = cause?.code || e?.code;
  if (code === 'ECONNREFUSED') {
    return `Sales.app tidak dapat dihubungi di ${salesUrl}`;
  }
  if (e?.name === 'TimeoutError' || code === 'ABORT_ERR') {
    return `Sales.app tidak merespons (timeout)`;
  }
  return e?.message || 'Gagal menghubungi sales.app';
}

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
      kode: it.vendorKode || it.localKode,
      qty: it.qtyReceived ?? it.qtyOrdered ?? 0,
      harga: it.harga || it.hargaSatuan || 0,
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

async function pollSalesGrnJob(
  salesAppUrl: string,
  salesApiKey: string,
  jobId: string,
  { maxWaitMs = 120_000, intervalMs = 2000 } = {},
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${salesAppUrl}/api/bg-jobs/${encodeURIComponent(jobId)}`, {
      headers: { 'X-Api-Key': salesApiKey },
      signal: AbortSignal.timeout(15000),
    });
    const job = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      return { error: String(job.error || `Sales job poll HTTP ${res.status}`) };
    }
    const status = String(job.status || '');
    if (status === 'DONE') {
      const result = (job.result || {}) as Record<string, unknown>;
      if (result.error) return { error: String(result.error), ...result };
      if (result.ok) return result;
      return result;
    }
    if (status === 'FAILED') {
      return { error: String(job.lastError || resultError(job) || 'Job sales gagal') };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { error: 'Timeout menunggu job grn-posted di sales.app' };
}

function resultError(job: Record<string, unknown>) {
  const result = job.result as Record<string, unknown> | undefined;
  return result?.error ? String(result.error) : null;
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

  const synced = await syncGrnDeliveryFromSales(db, tid, grn);
  const currentGrn = (synced.grn || grn) as Record<string, unknown>;

  const payload = {
    customerTenantId: tid,
    vendorTenantId: currentGrn.vendorTenantId || config.vendorTenantId,
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
      kode: it.vendorKode || it.localKode,
      qty: it.qtyReceived ?? it.qtyOrdered ?? 0,
      harga: it.harga || it.hargaSatuan || 0,
    })),
  };

  const url = `${config.salesAppUrl}/api/integrations/grn-posted`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': salesApiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { error: salesFetchErrorMessage(e, config.salesAppUrl), offline: true };
  }

  let data: Record<string, unknown>;
  try {
    data = await res.json() as Record<string, unknown>;
  } catch {
    return { error: `Sales.app merespons HTTP ${res.status} tanpa JSON valid` };
  }

  if (res.status === 202 && data.jobId) {
    const polled = await pollSalesGrnJob(config.salesAppUrl, salesApiKey, String(data.jobId));
    if (polled.error) {
      return {
        error: String(polled.error),
        draftNoInvoice: polled.draftNoInvoice,
        async: true,
        salesJobId: data.jobId,
      };
    }
    data = normalizeSalesGrnResponse(polled);
  } else if (!res.ok) {
    const hint = data.draftNoInvoice
      ? ` — DRAFT ${data.draftNoInvoice} ada di sales.app, post manual jika perlu`
      : '';
    return { error: `${data.error || `Sales.app ${res.status}`}${hint}`, draftNoInvoice: data.draftNoInvoice };
  }

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
