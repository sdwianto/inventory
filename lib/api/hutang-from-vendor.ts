import type { Db } from 'mongodb';
// Hutang usaha dari invoice vendor (sales.app) + koreksi credit note.

import { v4 as uuidv4 } from 'uuid';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { normalizeTenantId, tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { ensureVendorSupplier } from '@/lib/api/vendor-supplier';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { validateInvoiceAgainstGrn } from '@/lib/api/three-way-match';
import { poEstimasiFromDoc, resolveSoSnapshotForPo } from '@/lib/api/hutang-variance-enrich';
import { resolveSoTotals } from '@/lib/api/vendor-so-snapshot';
import { vendorBillingFromPayload } from '@/lib/api/hutang-detail-enrich';
import { resolveVendorDisplayName } from '@/lib/api/resolve-vendor-display-name';
import { createJournal } from '@/lib/api/journal';
import { buildVendorHutangJournalLines } from '@/lib/api/journal-lines';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { writeAuditLog } from '@/lib/api/audit-log';
import { logger } from '@/lib/api/logger';
import type { HutangDoc } from '@/types/documents';
import type { VendorInvoicePayload } from '@/types/integration';

async function resolveVendorBillingForHutang(
  db: Db,
  tid: string,
  payload: VendorInvoicePayload,
  vendorTenantId: string | null | undefined,
) {
  const vid = vendorTenantId || payload.vendorTenantId || null;
  const displayName = await resolveVendorDisplayName(db, tid, vid, payload);
  const billing = vendorBillingFromPayload(payload, vid);
  if (billing && !billing.companyName) {
    billing.companyName = displayName;
  }
  const billingSnap = billing || {
    vendorTenantId: vid,
    companyName: displayName,
    companyAddress: '',
    companyPhone: '',
    companyNPWP: '',
    logoBase64: '',
  };
  return { vid, billingSnap, displayName };
}

async function loadPoVarianceContext(
  db: Db,
  tid: string,
  payload: VendorInvoicePayload,
  vendorTenantId: string | null = null,
) {
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

  const hutangRef: HutangDoc = {
    vendorTenantId: vendorTenantId || payload.vendorTenantId || undefined,
    salesOrderId: payload.salesOrderId,
    noSO: payload.noSO ?? undefined,
  };
  const snap = resolveSoSnapshotForPo(po, hutangRef);
  let { subTotal: soSubTotal, total: soTotal } = resolveSoTotals(snap);

  const salesOrderTotal = parseInt(String(payload.salesOrderTotal || 0), 10);
  if (salesOrderTotal > soTotal) {
    soTotal = salesOrderTotal;
    if (!soSubTotal) soSubTotal = parseInt(String(payload.salesOrderSubTotal || 0), 10) || salesOrderTotal;
  }

  const poEstimasiTotal = poEstimasiFromDoc(po);

  return {
    poEstimasiTotal,
    soTotal,
    soSubTotal,
    variancePoToSo: soTotal - poEstimasiTotal,
    customerPoId: po.id,
    vendorSoSnapshot: snap || po.vendorSoSnapshot || null,
  };
}

function hasLegitimateApproval(hutang: HutangDoc) {
  const by = hutang?.approvedBy;
  if (!by?.userId || by.role === 'SYSTEM') return false;
  return !!hutang?.approvedAt;
}

function hasLegitimateExternalPayment(hutang: HutangDoc) {
  if (!hutang?.paidExternalAt) return false;
  return !!(hutang?.paidExternalBy?.userId);
}

/**
 * Tagihan vendor yang seharusnya menunggu review admin — termasuk artefak migrasi
 * (approvedBy.role SYSTEM) dan status lunas tanpa jejak pembayaran nyata.
 */
export function isVendorInvoiceHutang(hutang: HutangDoc) {
  return hutang?.referenceType === 'VENDOR_INVOICE' || !!hutang?.vendorInvoiceId;
}

export function vendorInvoiceNeedsPendingReview(
  hutang: HutangDoc,
  { fromPostedGrn = false }: { fromPostedGrn?: boolean } = {},
) {
  if (!isVendorInvoiceHutang(hutang)) return false;
  const approval = String(hutang?.approvalStatus || hutang?.status || '');
  if (approval === 'PENDING_REVIEW' || approval === 'REJECTED') return false;
  if (fromPostedGrn) {
    if (hasLegitimateExternalPayment(hutang)) return false;
    if (hasLegitimateApproval(hutang)) return false;
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
export function isBogusSettledVendorHutang(hutang: HutangDoc) {
  return vendorInvoiceNeedsPendingReview(hutang);
}

async function findExistingVendorHutang(db: Db, tid: string, invoiceId: string) {
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

async function syncExistingVendorHutangFromPayload(
  db: Db,
  tid: string,
  existing: HutangDoc,
  payload: VendorInvoicePayload,
  vendorTenantId: string | null | undefined,
) {
  let total = parseInt(String(payload.total || 0), 10);
  if (total <= 0) total = parseInt(String(payload.subTotal || 0), 10);

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

  const { billingSnap, displayName, vid } = await resolveVendorBillingForHutang(
    db,
    tid,
    payload,
    vendorTenantId,
  );
  const vendorNameStale = !!displayName
    && String(existing.supplierName || '').trim().toLowerCase() === 'sales.app vendor'
    && displayName.toLowerCase() !== 'sales.app vendor';

  if (!staleStatus && !totalMismatch && !invoiceMismatch && !vendorNameStale) {
    return {
      action: 'exists',
      hutangId: existing.id,
      noHutang: existing.noHutang,
      approvalStatus: existing.approvalStatus || existing.status,
    };
  }

  if (vendorNameStale && !staleStatus && !totalMismatch && !invoiceMismatch) {
    await ensureVendorSupplier(db, tid, vid || existing.vendorTenantId, displayName);
    await db.collection('hutang').updateOne(
      { id: existing.id },
      {
        $set: {
          supplierName: displayName,
          vendorBillingSnapshot: billingSnap,
          updatedAt: new Date(),
        },
      },
    );
    return {
      action: 'refreshed',
      hutangId: existing.id,
      noHutang: existing.noHutang,
      approvalStatus: existing.approvalStatus || existing.status,
    };
  }

  const match = await validateInvoiceAgainstGrn(db, tid, payload);
  const matchOk = match.ok === true;
  const varianceCtx = await loadPoVarianceContext(db, tid, payload, vendorTenantId);
  const varianceSoToInvoice = total - varianceCtx.soTotal;
  const now = new Date();

  await db.collection('hutang').updateOne(
    { id: existing.id },
    {
      $set: {
        tenantId: tid,
        referenceType: 'VENDOR_INVOICE',
        supplierName: displayName,
        vendorBillingSnapshot: billingSnap,
        noInvoice: payload.noInvoice || existing.noInvoice,
        noDO: payload.noDO || existing.noDO || null,
        noSO: payload.noSO || existing.noSO || null,
        noPO: payload.noPO || existing.noPO || null,
        customerPoId: varianceCtx.customerPoId || existing.customerPoId || null,
        deliveryId: payload.deliveryId || existing.deliveryId || null,
        salesOrderId: payload.salesOrderId || existing.salesOrderId || null,
        salesOrderTotal: parseInt(String(payload.salesOrderTotal || 0), 10) || existing.salesOrderTotal || null,
        salesOrderSubTotal: parseInt(String(payload.salesOrderSubTotal || 0), 10) || existing.salesOrderSubTotal || null,
        subTotal: parseInt(String(payload.subTotal || total), 10),
        ppn: parseInt(String(payload.ppn || 0), 10),
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

  await writeAuditLog(db, {
    tenantId: tid,
    action: 'HUTANG_UPDATED',
    entityType: 'hutang',
    entityId: String(existing.id),
    summary: `Hutang ${existing.noHutang} diperbarui dari invoice vendor`,
    metadata: {
      noInvoice: payload.noInvoice,
      total,
      matchStatus: matchOk ? 'MATCHED' : 'EXCEPTION',
    },
  });

  return {
    action: 'refreshed',
    hutangId: existing.id,
    noHutang: existing.noHutang,
    total,
    approvalStatus: 'PENDING_REVIEW',
    matchStatus: matchOk ? 'MATCHED' : 'EXCEPTION',
  };
}

export async function createHutangFromVendorInvoice(
  db: Db,
  customerTenantId: string,
  payload: VendorInvoicePayload,
  vendorTenantId: string | null | undefined,
) {
  const tid = normalizeTenantId(customerTenantId || 'default');
  const invoiceId = payload.invoiceId;
  if (!invoiceId) return { error: 'invoiceId wajib' };

  const existing = await findExistingVendorHutang(db, tid, invoiceId);
  if (existing) {
    return syncExistingVendorHutangFromPayload(db, tid, existing as HutangDoc, payload, vendorTenantId);
  }

  const paymentTerms = payload.paymentTerms || 'KREDIT';
  let total = parseInt(String(payload.total || 0), 10);
  if (total <= 0) total = parseInt(String(payload.subTotal || 0), 10);
  if (total <= 0) return { error: 'total invoice tidak valid' };

  const match = await validateInvoiceAgainstGrn(db, tid, payload);
  const matchOk = match.ok === true;

  const varianceCtx = await loadPoVarianceContext(db, tid, payload, vendorTenantId || null);
  const soTotal = varianceCtx.soTotal;
  const varianceSoToInvoice = total - soTotal;

  const { vid, billingSnap, displayName } = await resolveVendorBillingForHutang(
    db,
    tid,
    payload,
    vendorTenantId,
  );

  const sup = await ensureVendorSupplier(db, tid, vid, displayName);

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
    salesOrderTotal: parseInt(String(payload.salesOrderTotal || 0), 10) || null,
    salesOrderSubTotal: parseInt(String(payload.salesOrderSubTotal || 0), 10) || null,
    tanggal: payload.postedAt ? new Date(payload.postedAt) : now,
    supplierId: sup.id,
    supplierName: sup.nama,
    vendorTenantId: vendorTenantId || null,
    vendorBillingSnapshot: billingSnap,
    billToName: payload.pelangganName || payload.customerName || null,
    referenceType: 'VENDOR_INVOICE',
    referenceId: invoiceId,
    subTotal: parseInt(String(payload.subTotal || total), 10),
    ppn: parseInt(String(payload.ppn || 0), 10),
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

  await runInTransactionOrFallback(async ({ db: txDb, session }) => {
    await txDb.collection('hutang').insertOne(hutang, txOpts(session));

    const ppnAmt = parseInt(String(hutang.ppn || 0), 10);
    const totalAmt = parseInt(String(hutang.total || 0), 10);
    const subTotal = Math.max(0, totalAmt - ppnAmt);
    try {
      await createJournal(txDb, {
        tanggal: hutang.tanggal,
        keterangan: `Tagihan vendor ${payload.noInvoice || noHutang}`,
        sourceType: 'AUTO_HUTANG_VENDOR',
        sourceId: hutang.id,
        userName: payload.userName || 'System',
        details: buildVendorHutangJournalLines({
          noDoc: payload.noInvoice || noHutang,
          subTotal,
          ppn: ppnAmt,
          total: totalAmt,
        }),
        tenantId: tid,
      });
    } catch (e) {
      logger.warn('hutang journal skipped', {
        hutangId: hutang.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    if (payload.noDO) {
      await txDb.collection('goods_receipts').updateMany(
        { tenantId: tid, noDO: payload.noDO, vendorInvoiceId: { $exists: false } },
        { $set: { vendorInvoiceId: invoiceId, noInvoice: payload.noInvoice, hutangId: hutang.id } },
        txOpts(session),
      );
    }

    await writeAuditLog(txDb, {
      tenantId: tid,
      action: 'HUTANG_CREATED',
      entityType: 'hutang',
      entityId: hutang.id,
      summary: `Hutang vendor ${noHutang} dari invoice ${payload.noInvoice || invoiceId}`,
      metadata: { noDO: payload.noDO, total, matchStatus: hutang.matchStatus },
    }, session);
  });

  logger.info('hutang_created', { tenantId: tid, hutangId: hutang.id, noHutang, invoiceId });

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

export async function applyCreditNoteFromVendor(
  db: Db,
  customerTenantId: string,
  payload: VendorInvoicePayload & { creditNoteId?: string; noCN?: string },
  vendorTenantId: string | null | undefined,
) {
  const tid = customerTenantId || 'default';
  const invoiceId = payload.invoiceId;
  const creditTotal = parseInt(String(payload.total || 0), 10);
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
      } as never,
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
