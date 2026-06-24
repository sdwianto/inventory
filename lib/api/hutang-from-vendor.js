// Hutang usaha dari invoice vendor (sales.app) + koreksi credit note.

import { v4 as uuidv4 } from 'uuid';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { normalizeTenantId, tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { ensureVendorSupplier } from '@/lib/api/vendor-supplier';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { validateInvoiceAgainstGrn } from '@/lib/api/three-way-match';
import { sumPoEstimasi } from '@/lib/api/po-estimasi';
import { vendorBillingFromPayload } from '@/lib/api/hutang-detail-enrich';

async function loadPoVarianceContext(db, tid, payload) {
  const noPO = payload.noPO;
  if (!noPO) {
    return {
      poEstimasiTotal: 0,
      soTotal: 0,
      soSubTotal: 0,
      variancePoToSo: 0,
      customerPoId: null,
    };
  }

  const po = await db.collection('customer_purchase_orders').findOne({ tenantId: tid, noPO });
  if (!po) {
    return {
      poEstimasiTotal: 0,
      soTotal: 0,
      soSubTotal: 0,
      variancePoToSo: 0,
      customerPoId: null,
    };
  }

  const poEstimasiTotal = po.estimasiTotal ?? sumPoEstimasi(po.items);
  const soTotal = parseInt(po.vendorSoSnapshot?.total || 0, 10);
  const soSubTotal = parseInt(po.vendorSoSnapshot?.subTotal || 0, 10);

  return {
    poEstimasiTotal,
    soTotal,
    soSubTotal,
    variancePoToSo: soTotal - poEstimasiTotal,
    customerPoId: po.id,
    vendorSoSnapshot: po.vendorSoSnapshot || null,
  };
}

function hasLegitimateApproval(hutang) {
  const by = hutang?.approvedBy;
  if (!by?.userId || by.role === 'SYSTEM') return false;
  return !!hutang?.approvedAt;
}

function hasLegitimateExternalPayment(hutang) {
  if (!hutang?.paidExternalAt) return false;
  return !!(hutang?.paidExternalBy?.userId);
}

/**
 * Tagihan vendor yang seharusnya menunggu review admin — termasuk artefak migrasi
 * (approvedBy.role SYSTEM) dan status lunas tanpa jejak pembayaran nyata.
 */
export function isVendorInvoiceHutang(hutang) {
  return hutang?.referenceType === 'VENDOR_INVOICE' || !!hutang?.vendorInvoiceId;
}

export function vendorInvoiceNeedsPendingReview(hutang, { fromPostedGrn = false } = {}) {
  if (!isVendorInvoiceHutang(hutang)) return false;
  const approval = hutang?.approvalStatus || hutang?.status;
  if (approval === 'PENDING_REVIEW' || approval === 'REJECTED') return false;
  if (fromPostedGrn) {
    if (approval === 'PENDING_REVIEW' || approval === 'REJECTED') return false;
    if (hasLegitimateExternalPayment(hutang)) return false;
    // Tagihan dari GRN POSTED wajib review admin — reset APPROVED/PAID_EXTERNAL tanpa jejak bayar luar
    return true;
  }
  if (approval === 'APPROVED' && hasLegitimateApproval(hutang)) return false;
  if (approval === 'PARTIAL' && hasLegitimateApproval(hutang)) return false;
  if (['PAID_EXTERNAL', 'LUNAS'].includes(approval) && hasLegitimateExternalPayment(hutang)) {
    return false;
  }
  return true;
}

/** @deprecated Prefer vendorInvoiceNeedsPendingReview — kept for reconcile callers. */
export function isBogusSettledVendorHutang(hutang) {
  return vendorInvoiceNeedsPendingReview(hutang);
}

async function findExistingVendorHutang(db, tid, invoiceId) {
  const byTenant = await db.collection('hutang').findOne({
    vendorInvoiceId: invoiceId,
    ...tenantIdMatchFilter(tid),
  });
  if (byTenant) return byTenant;

  const global = await db.collection('hutang').findOne({ vendorInvoiceId: invoiceId });
  if (global && normalizeTenantId(global.tenantId) !== normalizeTenantId(tid)) {
    await db.collection('hutang').updateOne(
      { id: global.id },
      { $set: { tenantId: normalizeTenantId(tid), updatedAt: new Date() } },
    );
    return { ...global, tenantId: normalizeTenantId(tid) };
  }
  return global;
}

async function syncExistingVendorHutangFromPayload(db, tid, existing, payload, vendorTenantId) {
  let total = parseInt(payload.total || 0, 10);
  if (total <= 0) total = parseInt(payload.subTotal || 0, 10);

  let fromPostedGrn = false;
  if (payload.noDO) {
    const grn = await db.collection('goods_receipts').findOne({
      ...tenantIdMatchFilter(tid),
      noDO: payload.noDO,
      status: 'POSTED',
    });
    fromPostedGrn = !!grn;
  }

  const staleStatus = vendorInvoiceNeedsPendingReview(existing, { fromPostedGrn });
  const totalMismatch = total > 0 && Math.abs((existing.total || 0) - total) > 1;
  const invoiceMismatch = payload.noInvoice && existing.noInvoice !== payload.noInvoice;

  if (!staleStatus && !totalMismatch && !invoiceMismatch) {
    return {
      action: 'exists',
      hutangId: existing.id,
      noHutang: existing.noHutang,
      approvalStatus: existing.approvalStatus || existing.status,
    };
  }

  const match = await validateInvoiceAgainstGrn(db, tid, payload);
  const matchOk = match.ok === true;
  const varianceCtx = await loadPoVarianceContext(db, tid, payload);
  const varianceSoToInvoice = total - varianceCtx.soTotal;
  const now = new Date();

  await db.collection('hutang').updateOne(
    { id: existing.id },
    {
      $set: {
        tenantId: tid,
        referenceType: 'VENDOR_INVOICE',
        noInvoice: payload.noInvoice || existing.noInvoice,
        noDO: payload.noDO || existing.noDO || null,
        noSO: payload.noSO || existing.noSO || null,
        noPO: payload.noPO || existing.noPO || null,
        customerPoId: varianceCtx.customerPoId || existing.customerPoId || null,
        deliveryId: payload.deliveryId || existing.deliveryId || null,
        salesOrderId: payload.salesOrderId || existing.salesOrderId || null,
        subTotal: parseInt(payload.subTotal || total, 10),
        ppn: parseInt(payload.ppn || 0, 10),
        total,
        terbayar: 0,
        sisa: total,
        status: 'PENDING_REVIEW',
        approvalStatus: 'PENDING_REVIEW',
        paymentTerms: payload.paymentTerms || existing.paymentTerms || 'KREDIT',
        items: payload.items || existing.items || [],
        matchStatus: matchOk ? 'MATCHED' : 'EXCEPTION',
        matchError: matchOk ? null : (match.error || null),
        matchCode: matchOk ? null : (match.code || null),
        matchGrnCount: match.grnCount || 0,
        grnValue: match.grnValue || 0,
        poEstimasiTotal: varianceCtx.poEstimasiTotal,
        soTotal: varianceCtx.soTotal,
        soSubTotal: varianceCtx.soSubTotal,
        variancePoToSo: varianceCtx.variancePoToSo,
        varianceSoToInvoice,
        updatedAt: now,
      },
      $unset: {
        paidExternalAt: '',
        paidExternalBy: '',
        paidExternalNote: '',
        approvedAt: '',
        approvedBy: '',
        rejectedAt: '',
        rejectedBy: '',
        rejectReason: '',
        matchOverride: '',
        matchOverrideNote: '',
        matchOverrideBy: '',
      },
    },
  );

  return {
    action: 'refreshed',
    hutangId: existing.id,
    noHutang: existing.noHutang,
    total,
    approvalStatus: 'PENDING_REVIEW',
    matchStatus: matchOk ? 'MATCHED' : 'EXCEPTION',
  };
}

export async function createHutangFromVendorInvoice(db, customerTenantId, payload, vendorTenantId) {
  const tid = normalizeTenantId(customerTenantId || 'default');
  const invoiceId = payload.invoiceId;
  if (!invoiceId) return { error: 'invoiceId wajib' };

  const existing = await findExistingVendorHutang(db, tid, invoiceId);
  if (existing) {
    return syncExistingVendorHutangFromPayload(db, tid, existing, payload, vendorTenantId);
  }

  const paymentTerms = payload.paymentTerms || 'KREDIT';
  let total = parseInt(payload.total || 0, 10);
  if (total <= 0) total = parseInt(payload.subTotal || 0, 10);
  if (total <= 0) return { error: 'total invoice tidak valid' };

  const match = await validateInvoiceAgainstGrn(db, tid, payload);
  const matchOk = match.ok === true;

  const varianceCtx = await loadPoVarianceContext(db, tid, payload);
  const soTotal = varianceCtx.soTotal;
  const varianceSoToInvoice = total - soTotal;

  const vendorBillingSnapshot = vendorBillingFromPayload(payload, vendorTenantId);

  const sup = await ensureVendorSupplier(
    db,
    tid,
    vendorTenantId,
    vendorBillingSnapshot.companyName || payload.vendorName || 'sales.app Vendor',
  );
  if (!vendorBillingSnapshot.companyName) {
    vendorBillingSnapshot.companyName = sup.nama;
  }

  const now = new Date();
  const jatuhTempo = payload.jatuhTempo ? new Date(payload.jatuhTempo) : new Date(now.getTime() + 30 * 86400000);

  const noHutang = await nextDocNumber(db, tid, 'HUTANG', 'HT');

  const hutang = stampTenantId(tid, {
    id: uuidv4(),
    noHutang,
    noInvoice: payload.noInvoice,
    vendorInvoiceId: invoiceId,
    noDO: payload.noDO || null,
    noSO: payload.noSO || null,
    noPO: payload.noPO || null,
    customerPoId: varianceCtx.customerPoId,
    deliveryId: payload.deliveryId || null,
    salesOrderId: payload.salesOrderId || null,
    tanggal: payload.postedAt ? new Date(payload.postedAt) : now,
    supplierId: sup.id,
    supplierName: sup.nama,
    vendorTenantId: vendorTenantId || null,
    vendorBillingSnapshot,
    billToName: payload.pelangganName || payload.customerName || null,
    referenceType: 'VENDOR_INVOICE',
    referenceId: invoiceId,
    subTotal: parseInt(payload.subTotal || total, 10),
    ppn: parseInt(payload.ppn || 0, 10),
    total,
    terbayar: 0,
    sisa: total,
    jatuhTempo,
    status: 'PENDING_REVIEW',
    approvalStatus: 'PENDING_REVIEW',
    paymentTerms,
    items: payload.items || [],
    matchStatus: matchOk ? 'MATCHED' : 'EXCEPTION',
    matchError: matchOk ? null : (match.error || null),
    matchCode: matchOk ? null : (match.code || null),
    matchGrnCount: match.grnCount || 0,
    grnValue: match.grnValue || 0,
    poEstimasiTotal: varianceCtx.poEstimasiTotal,
    soTotal: varianceCtx.soTotal,
    soSubTotal: varianceCtx.soSubTotal,
    variancePoToSo: varianceCtx.variancePoToSo,
    varianceSoToInvoice,
    createdAt: now,
  });

  await db.collection('hutang').insertOne(hutang);

  if (payload.noDO) {
    await db.collection('goods_receipts').updateMany(
      { tenantId: tid, noDO: payload.noDO, vendorInvoiceId: { $exists: false } },
      { $set: { vendorInvoiceId: invoiceId, noInvoice: payload.noInvoice, hutangId: hutang.id } },
    );
  }

  return {
    action: 'created',
    hutangId: hutang.id,
    noHutang: hutang.noHutang,
    total,
    approvalStatus: hutang.approvalStatus,
    matchStatus: hutang.matchStatus,
    paymentTerms,
  };
}

export async function applyCreditNoteFromVendor(db, customerTenantId, payload, vendorTenantId) {
  const tid = customerTenantId || 'default';
  const invoiceId = payload.invoiceId;
  const creditTotal = parseInt(payload.total || 0, 10);
  if (!invoiceId || creditTotal <= 0) return { error: 'invoiceId dan total wajib' };

  const hutang = await db.collection('hutang').findOne({
    tenantId: tid,
    vendorInvoiceId: invoiceId,
    referenceType: 'VENDOR_INVOICE',
  });
  if (!hutang) return { action: 'no_hutang', invoiceId };

  const reduce = Math.min(creditTotal, hutang.sisa || 0);
  if (reduce <= 0) return { action: 'nothing_to_reduce' };

  const now = new Date();
  const newTerbayar = (hutang.terbayar || 0) + reduce;
  const newSisa = hutang.total - newTerbayar;
  const paidStatuses = new Set(['APPROVED', 'PAID_EXTERNAL', 'LUNAS']);
  const newStatus = newSisa <= 0 && paidStatuses.has(hutang.approvalStatus)
    ? 'PAID_EXTERNAL'
    : hutang.status;

  await db.collection('hutang').updateOne(
    { id: hutang.id },
    {
      $set: {
        terbayar: newTerbayar,
        sisa: newSisa,
        status: newSisa <= 0 ? newStatus : hutang.status,
        approvalStatus: newSisa <= 0 && hutang.approvalStatus === 'APPROVED'
          ? 'PAID_EXTERNAL'
          : hutang.approvalStatus,
        updatedAt: now,
      },
      $push: {
        creditNotes: {
          creditNoteId: payload.creditNoteId,
          noCN: payload.noCN,
          amount: reduce,
          postedAt: payload.postedAt || now,
        },
      },
    },
  );

  return {
    action: 'credit_applied',
    hutangId: hutang.id,
    reduced: reduce,
    sisa: newSisa,
    vendorTenantId,
  };
}
