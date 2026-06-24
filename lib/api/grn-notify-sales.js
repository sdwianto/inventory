// Beritahu sales.app bahwa GRN sudah POSTED → auto-create & post invoice B2B + record hutang lokal.

import { getIntegrationConfig } from '@/lib/api/integration-config';
import { createHutangFromVendorInvoice } from '@/lib/api/hutang-from-vendor';
import { syncCpoFromVendorEvent } from '@/lib/api/cpo-status-sync';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import { syncGrnDeliveryFromSales } from '@/lib/api/grn-delivery-sync';

function salesFetchErrorMessage(err, salesUrl) {
  const cause = err?.cause;
  const code = cause?.code || err?.code;
  if (code === 'ECONNREFUSED') {
    return `Sales.app tidak dapat dihubungi di ${salesUrl}`;
  }
  if (err?.name === 'TimeoutError' || code === 'ABORT_ERR') {
    return `Sales.app tidak merespons (timeout)`;
  }
  return err?.message || 'Gagal menghubungi sales.app';
}

function buildInvoicePayloadFromSales(data, grn) {
  if (data.invoicePayload?.invoiceId) return data.invoicePayload;

  const invoiceId = data.invoiceId || data.invoicePayload?.invoiceId;
  if (!invoiceId) return null;

  const total = parseInt(data.invoicePayload?.total || data.total || grn.receivedTotal || 0, 10);
  return {
    invoiceId,
    noInvoice: data.noInvoice || data.invoicePayload?.noInvoice,
    noDO: data.invoicePayload?.noDO || grn.noDO,
    noPO: data.invoicePayload?.noPO || grn.noPO || null,
    noSO: data.invoicePayload?.noSO || grn.noSO || null,
    deliveryId: data.invoicePayload?.deliveryId || null,
    salesOrderId: data.invoicePayload?.salesOrderId || null,
    subTotal: parseInt(data.invoicePayload?.subTotal || total, 10),
    ppn: parseInt(data.invoicePayload?.ppn || 0, 10),
    total,
    paymentTerms: data.invoicePayload?.paymentTerms || 'KREDIT',
    jatuhTempo: data.invoicePayload?.jatuhTempo || null,
    items: data.invoicePayload?.items || (grn.items || []).map((it) => ({
      kode: it.vendorKode || it.localKode,
      qty: it.qtyReceived ?? it.qtyOrdered ?? 0,
      harga: it.harga || it.hargaSatuan || 0,
    })),
    postedAt: data.invoicePayload?.postedAt || grn.postedAt || new Date(),
    pelangganName: data.invoicePayload?.pelangganName || null,
    vendorName: data.invoicePayload?.vendorName || null,
  };
}

async function upsertHutangFromSalesPayload(db, tenantId, data, grn, config) {
  const tid = normalizeTenantId(grn?.tenantId || tenantId);
  const payload = buildInvoicePayloadFromSales(data, grn);
  if (!payload?.invoiceId) {
    return { skipped: true, reason: 'no_invoice_payload' };
  }

  const vendorTenantId = data.vendorTenantId || grn.vendorTenantId || config.vendorTenantId;
  const result = await createHutangFromVendorInvoice(
    db,
    tid,
    payload,
    vendorTenantId,
  );

  if (result.error) {
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

function tidFromGrn(grn) {
  return String(grn?.tenantId || 'sppg').trim().toLowerCase();
}

function buildFallbackDeliverySnapshot(grn) {
  if (grn?.vendorDeliverySnapshot?.deliveryId || grn?.vendorDeliverySnapshot?.items?.length) {
    const snap = { ...grn.vendorDeliverySnapshot };
    if (!snap.customerTenantId) snap.customerTenantId = tidFromGrn(grn);
    return snap;
  }
  if (!grn?.vendorDeliveryId && !grn?.noDO) return null;
  return {
    deliveryId: grn.vendorDeliveryId || null,
    noDO: grn.noDO,
    noSO: grn.noSO,
    noPO: grn.noPO,
    vendorTenantId: grn.vendorTenantId,
    customerTenantId: tidFromGrn(grn),
    items: (grn.items || []).map((it) => ({
      lineId: it.lineId,
      kode: it.vendorKode || it.localKode,
      nama: it.vendorNama || it.localNama,
      qty: it.qtyOrdered ?? it.qtyReceived ?? 0,
      harga: it.harga || it.hargaSatuan || 0,
      satuan: it.satuan,
    })),
  };
}

export async function notifyGrnPostedToSales(db, tenantId, grn) {
  const tid = normalizeTenantId(grn?.tenantId || tenantId);
  const config = await getIntegrationConfig(db, tid);
  if (!config.salesApiKey) {
    return { skipped: true, reason: 'not_paired' };
  }
  if (!grn?.noDO && !grn?.vendorDeliveryId) {
    return { skipped: true, reason: 'no_do_or_delivery_id' };
  }

  const synced = await syncGrnDeliveryFromSales(db, tid, grn);
  const currentGrn = synced.grn || grn;

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
    items: (currentGrn.items || []).map((it) => ({
      kode: it.vendorKode || it.localKode,
      qty: it.qtyReceived ?? it.qtyOrdered ?? 0,
      harga: it.harga || it.hargaSatuan || 0,
    })),
  };

  const url = `${config.salesAppUrl}/api/integrations/grn-posted`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': config.salesApiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    return { error: salesFetchErrorMessage(e, config.salesAppUrl), offline: true };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { error: `Sales.app merespons HTTP ${res.status} tanpa JSON valid` };
  }

  if (!res.ok) {
    const hint = data.draftNoInvoice
      ? ` — DRAFT ${data.draftNoInvoice} ada di sales.app, post manual jika perlu`
      : '';
    return { error: `${data.error || `Sales.app ${res.status}`}${hint}`, draftNoInvoice: data.draftNoInvoice };
  }

  if (!data.invoiceId) {
    return { error: 'Sales.app tidak mengembalikan invoiceId — faktur tidak dibuat' };
  }

  const hutang = await upsertHutangFromSalesPayload(db, tid, data, currentGrn, config);

  if (!hutang.error && !hutang.skipped && data.noInvoice && grn.noPO) {
    await syncCpoFromVendorEvent(db, tid, 'invoice.posted', {
      noPO: grn.noPO,
      noInvoice: data.noInvoice,
      invoiceId: data.invoiceId,
      total: data.invoicePayload?.total || data.total || grn.receivedTotal,
      postedAt: data.invoicePayload?.postedAt || grn.postedAt || new Date(),
    });
  }

  return {
    noInvoice: data.noInvoice || hutang.noInvoice,
    invoiceId: data.invoiceId,
    webhookSent: data.webhookSent,
    created: data.created,
    posted: data.posted,
    hutang,
  };
}
