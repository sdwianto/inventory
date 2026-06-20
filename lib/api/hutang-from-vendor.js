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

export async function createHutangFromVendorInvoice(db, customerTenantId, payload, vendorTenantId) {
  const tid = normalizeTenantId(customerTenantId || 'default');
  const invoiceId = payload.invoiceId;
  if (!invoiceId) return { error: 'invoiceId wajib' };

  const existing = await db.collection('hutang').findOne({
    vendorInvoiceId: invoiceId,
    referenceType: 'VENDOR_INVOICE',
    ...tenantIdMatchFilter(tid),
  });
  if (existing) {
    return {
      action: 'exists',
      hutangId: existing.id,
      noHutang: existing.noHutang,
      approvalStatus: existing.approvalStatus || existing.status,
    };
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
