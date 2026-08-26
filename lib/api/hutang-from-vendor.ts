import type { Db } from 'mongodb';
// Hutang usaha dari invoice vendor (sales.app) + koreksi credit note.

import { v4 as uuidv4 } from 'uuid';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { normalizeTenantId, tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { ensureVendorSupplier } from '@/lib/api/vendor-supplier';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { validateInvoiceAgainstGrn } from '@/lib/api/three-way-match';
import { poEstimasiForHutang, resolveSoSnapshotForPo } from '@/lib/api/hutang-variance-enrich';
import { resolveSoTotals } from '@/lib/api/vendor-so-snapshot';
import { resolveVendorBillingForStorage } from '@/lib/api/hutang-detail-enrich';
import { resolveVendorDisplayName } from '@/lib/api/resolve-vendor-display-name';
import { createJournal, createJournalIfNotExists } from '@/lib/api/journal';
import { buildVendorHutangJournalLines, buildCreditNoteHutangJournalLines } from '@/lib/api/journal-lines';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { writeAuditLog } from '@/lib/api/audit-log';
import { logger } from '@/lib/api/logger';
import type { GrnDoc, HutangDoc } from '@/types/documents';
import type { VendorInvoicePayload, VendorInvoiceLine } from '@/types/integration';
import { hutangMatchesGrnVendor, hutangVendorKey } from '@/lib/api/hutang-vendor-match';
import { reconcileHutangItemsFromGrn, type HutangItemLike } from '@/lib/api/hutang-line-reconcile';

/**
 * Cari GRN POSTED terkait invoice (by noDO, sama seperti validateInvoiceAgainstGrn) dan
 * koreksi qty/total invoice SEBELUM disimpan — jangan biarkan hutang tercatat menagih qty
 * yang GRN-nya menunjukkan ditolak/tidak diterima (lihat GRN2608000010, GRN2608000019).
 * matchStatus tetap dihitung dari payload asli (informasional — histori apa yang ditagih
 * vendor), tapi qty/total yang TERSIMPAN sudah correct dari awal, bukan cuma hasil koreksi
 * manual belakangan lewat Sync Pending.
 */
export async function correctInvoiceItemsAgainstGrn(
  db: Db,
  tid: string,
  payload: VendorInvoicePayload,
): Promise<{ items: VendorInvoiceLine[]; total: number; corrected: boolean; grn: GrnDoc | null }> {
  const rawItems = (payload.items || []) as VendorInvoiceLine[];
  const rawTotal = parseInt(String(payload.total || payload.subTotal || 0), 10) || 0;
  if (!payload.noDO) return { items: rawItems, total: rawTotal, corrected: false, grn: null };

  const grnFilter: Record<string, unknown> = {
    noDO: payload.noDO,
    status: 'POSTED',
    ...tenantIdMatchFilter(tid),
  };
  if (payload.vendorTenantId) grnFilter.vendorTenantId = payload.vendorTenantId;
  const grns = await db.collection('goods_receipts').find(grnFilter).toArray() as GrnDoc[];
  if (!grns.length) return { items: rawItems, total: rawTotal, corrected: false, grn: null };

  const grnItems = grns.flatMap((g) => g.items || []);
  const reconciled = reconcileHutangItemsFromGrn(rawItems as HutangItemLike[], grnItems);
  if (reconciled.matchedCount === 0 || !reconciled.changed) {
    return { items: rawItems, total: rawTotal, corrected: false, grn: grns[0] };
  }
  return {
    items: reconciled.items as VendorInvoiceLine[],
    total: reconciled.total,
    corrected: true,
    grn: grns[0],
  };
}

export type HutangCreateOptions = {
  createdVia?: 'grn-posted' | 'invoice-posted-webhook' | 'invoice-posted-push';
  /** W1-3: ops spine Entity → CID → integration_commands. */
  correlationId?: string | null;
};

/** Skip webhook invoice.posted jika hutang sudah dibuat lewat jalur grn-posted (primary). */
export async function hutangAlreadyFromGrnPrimaryPath(
  db: Db,
  customerTenantId: string,
  payload: VendorInvoicePayload,
  vendorTenantId?: string | null,
) {
  const tid = normalizeTenantId(customerTenantId || 'default');
  const invoiceId = payload.invoiceId;
  if (invoiceId) {
    const existing = await findExistingVendorHutang(db, tid, invoiceId, vendorTenantId);
    if (existing) {
      return {
        action: 'exists' as const,
        hutangId: existing.id,
        noHutang: existing.noHutang,
        createdVia: (existing as HutangDoc).createdVia || null,
        skippedWebhook: (existing as HutangDoc).createdVia === 'grn-posted'
          || (existing as HutangDoc).createdVia === 'invoice-posted-push',
      };
    }
  }
  const noDO = payload.noDO;
  if (!noDO) return null;

  const grnFilter: Record<string, unknown> = {
    ...tenantIdMatchFilter(tid),
    noDO,
    status: 'POSTED',
  };
  const vid = hutangVendorKey(vendorTenantId);
  if (vid) grnFilter.vendorTenantId = vid;

  const grn = await db.collection('goods_receipts').findOne(grnFilter);
  if (!grn?.hutangId && !grn?.vendorInvoiceId) return null;

  if (grn.hutangId) {
    const hutang = await db.collection('hutang').findOne({ id: grn.hutangId });
    if (hutang) {
      return {
        action: 'exists' as const,
        hutangId: hutang.id,
        noHutang: hutang.noHutang,
        createdVia: (hutang as HutangDoc).createdVia || 'grn-posted',
        skippedWebhook: true,
      };
    }
  }
  return null;
}

async function resolveVendorBillingForHutang(
  db: Db,
  tid: string,
  payload: VendorInvoicePayload,
  vendorTenantId: string | null | undefined,
) {
  const vid = vendorTenantId || payload.vendorTenantId || null;
  const displayName = await resolveVendorDisplayName(db, tid, vid, payload);
  const payloadRec = payload as VendorInvoicePayload & Record<string, unknown>;
  const nested = payloadRec.vendor || payloadRec.vendorStore || {};
  const nestedObj = nested as Record<string, unknown>;
  const billingSnap = await resolveVendorBillingForStorage(db, tid, vid, {
    vendorTenantId: vid,
    companyName: nestedObj.companyName || payloadRec.vendorCompanyName || payloadRec.vendorName || displayName,
    companyAddress: nestedObj.companyAddress || payloadRec.vendorAddress || '',
    companyPhone: nestedObj.companyPhone || payloadRec.vendorPhone || '',
    companyNPWP: nestedObj.companyNPWP || payloadRec.vendorNPWP || '',
    logoBase64: nestedObj.logoBase64 || payloadRec.vendorLogoBase64 || '',
    logoUrl: nestedObj.logoUrl || payloadRec.vendorLogoUrl || '',
    warnaBrand: nestedObj.warnaBrand || payloadRec.vendorWarnaBrand || '',
  });
  if (!billingSnap.companyName) billingSnap.companyName = displayName;
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

  const poEstimasiTotal = poEstimasiForHutang(po, hutangRef);

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

async function findExistingVendorHutang(
  db: Db,
  tid: string,
  invoiceId: string,
  vendorTenantId?: string | null,
) {
  const vid = hutangVendorKey(vendorTenantId);
  const tenantFilter = tenantIdMatchFilter(tid);

  if (vid) {
    const scoped = await db.collection('hutang').findOne({
      vendorInvoiceId: invoiceId,
      vendorTenantId: vid,
      ...tenantFilter,
    });
    if (scoped) return scoped;
    return null;
  }

  const byTenant = await db.collection('hutang').findOne({
    vendorInvoiceId: invoiceId,
    ...tenantFilter,
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

export type HutangSettlementFields = {
  terbayar: number;
  sisa: number;
  status: string;
  approvalStatus: string;
  jatuhTempo: Date;
};

/**
 * Semua invoice vendor (apa pun paymentTerms-nya) selalu PENDING_REVIEW saat
 * dibuat/disinkron — admin wajib review & approve manual sebelum lunas. jatuhTempo
 * dari payload (sudah dihitung sales.app dari TOP pelanggan); fallback +30 hari
 * hanya untuk data darurat yang benar-benar tidak mengirimkannya.
 */
export function resolveHutangSettlement(
  total: number,
  payloadJatuhTempo: string | Date | null | undefined,
  txnDate: Date,
): HutangSettlementFields {
  const jatuhTempo = payloadJatuhTempo
    ? new Date(payloadJatuhTempo)
    : new Date(txnDate.getTime() + 30 * 86400000);
  return { terbayar: 0, sisa: total, status: 'PENDING_REVIEW', approvalStatus: 'PENDING_REVIEW', jatuhTempo };
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

  const match = await validateInvoiceAgainstGrn(db, tid, payload, { excludeHutangId: existing.id });
  const matchOk = match.ok === true;
  // matchStatus tetap dihitung dari payload asli (histori apa yang ditagih vendor) —
  // tapi qty/total yang benar-benar TERSIMPAN dikoreksi ke qtyReceived GRN dulu, supaya
  // hutang tidak pernah menagih barang yang GRN-nya bilang ditolak/tidak diterima.
  const invCorrection = await correctInvoiceItemsAgainstGrn(db, tid, payload);
  const invoiceItems = invCorrection.items;
  if (invCorrection.corrected) total = invCorrection.total;
  const varianceCtx = await loadPoVarianceContext(db, tid, payload, vendorTenantId);
  const varianceSoToInvoice = total - varianceCtx.soTotal;
  const now = new Date();
  const paymentTerms = payload.paymentTerms || String(existing.paymentTerms || '') || 'KREDIT';
  const existingTanggal = existing.tanggal as string | Date | undefined;
  const txnDate = payload.postedAt ? new Date(payload.postedAt) : (existingTanggal ? new Date(existingTanggal) : now);
  const settlement = resolveHutangSettlement(total, payload.jatuhTempo, txnDate);

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
        subTotal: invCorrection.corrected ? total : parseInt(String(payload.subTotal || total), 10),
        ppn: parseInt(String(payload.ppn || 0), 10),
        total,
        terbayar: settlement.terbayar,
        sisa: settlement.sisa,
        status: settlement.status,
        approvalStatus: settlement.approvalStatus,
        paymentTerms,
        items: invoiceItems.length ? invoiceItems : (existing.items || []),
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
      correctedFromGrn: invCorrection.corrected,
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

/** Tandai GRN invoice sync selesai (webhook invoice.posted / recovery). */
async function markGrnInvoiceSyncDone(
  db: Db,
  tid: string,
  payload: VendorInvoicePayload,
  hutangId: string,
  invoiceId: string,
  vendorTenantId: string | null | undefined,
) {
  if (!payload.noDO) return;
  const grnFilter: Record<string, unknown> = {
    ...tenantIdMatchFilter(tid),
    noDO: payload.noDO,
    status: 'POSTED',
    invoiceSyncStatus: { $in: ['PENDING', 'SYNCING', 'FAILED', 'NONE'] },
  };
  const vid = hutangVendorKey(vendorTenantId);
  if (vid) grnFilter.vendorTenantId = vid;
  await db.collection('goods_receipts').updateMany(grnFilter, {
    $set: {
      vendorInvoiceId: invoiceId,
      noInvoice: payload.noInvoice,
      hutangId,
      invoiceSyncStatus: 'DONE',
      invoiceSyncError: null,
      invoiceSyncAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

export async function createHutangFromVendorInvoice(
  db: Db,
  customerTenantId: string,
  payload: VendorInvoicePayload,
  vendorTenantId: string | null | undefined,
  opts: HutangCreateOptions = {},
) {
  const tid = normalizeTenantId(customerTenantId || 'default');
  const invoiceId = payload.invoiceId;
  if (!invoiceId) return { error: 'invoiceId wajib' };

  const existing = await findExistingVendorHutang(db, tid, invoiceId, vendorTenantId);
  if (existing) {
    const result = await syncExistingVendorHutangFromPayload(
      db,
      tid,
      existing as HutangDoc,
      payload,
      vendorTenantId,
    );
    const cid = opts.correlationId ? String(opts.correlationId).trim() : '';
    if (cid && result.hutangId) {
      await db.collection('hutang').updateOne(
        { id: result.hutangId },
        { $set: { correlationId: cid } },
      );
    }
    if (!('error' in result && result.error) && result.hutangId) {
      await markGrnInvoiceSyncDone(
        db,
        tid,
        payload,
        String(result.hutangId),
        invoiceId,
        vendorTenantId,
      );
    }
    return result;
  }

  const paymentTerms = payload.paymentTerms || 'KREDIT';
  let total = parseInt(String(payload.total || 0), 10);
  if (total <= 0) total = parseInt(String(payload.subTotal || 0), 10);
  if (total <= 0) return { error: 'total invoice tidak valid' };

  const match = await validateInvoiceAgainstGrn(db, tid, payload);
  const matchOk = match.ok === true;

  // matchStatus di atas tetap dari payload asli (histori apa yang ditagih vendor) — tapi
  // qty/total yang TERSIMPAN dikoreksi ke qtyReceived GRN dulu, supaya hutang tidak pernah
  // menagih barang yang GRN-nya bilang ditolak/tidak diterima (boleh turun sampai 0).
  const invCorrection = await correctInvoiceItemsAgainstGrn(db, tid, payload);
  const invoiceItems = invCorrection.items;
  if (invCorrection.corrected) total = invCorrection.total;

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
  const tanggal = payload.postedAt ? new Date(payload.postedAt) : now;
  const settlement = resolveHutangSettlement(total, payload.jatuhTempo, tanggal);

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
    tanggal,
    supplierId: sup.id,
    supplierName: sup.nama,
    vendorTenantId: vendorTenantId || null,
    vendorBillingSnapshot: billingSnap,
    billToName: payload.pelangganName || payload.customerName || null,
    referenceType: 'VENDOR_INVOICE',
    referenceId: invoiceId,
    subTotal: invCorrection.corrected ? total : parseInt(String(payload.subTotal || total), 10),
    ppn: parseInt(String(payload.ppn || 0), 10),
    total,
    terbayar: settlement.terbayar,
    sisa: settlement.sisa,
    jatuhTempo: settlement.jatuhTempo,
    status: settlement.status,
    approvalStatus: settlement.approvalStatus,
    paymentTerms,
    items: invoiceItems,
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
    createdVia: opts.createdVia || null,
    correlationId: opts.correlationId ? String(opts.correlationId).trim() || null : null,
    createdAt: now,
  });

  await runInTransactionOrFallback(async ({ db: txDb, session }) => {
    await txDb.collection('hutang').insertOne(hutang, txOpts(session));

    const ppnAmt = parseInt(String(hutang.ppn || 0), 10);
    const totalAmt = parseInt(String(hutang.total || 0), 10);
    const subTotal = Math.max(0, totalAmt - ppnAmt);
    let clearGrni = false;
    if (payload.noDO) {
      const grn = await txDb.collection('goods_receipts').findOne(
        { tenantId: tid, noDO: payload.noDO },
        txOpts(session),
      );
      if (grn?.id) {
        const accrual = await txDb.collection('jurnal').findOne({
          tenantId: tid,
          sourceType: 'AUTO_GRN_ACCRUAL',
          sourceId: String(grn.id),
        }, txOpts(session));
        clearGrni = Boolean(accrual);
      }
    }
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
        clearGrni,
      }),
      tenantId: tid,
    }, session);

    if (payload.noDO) {
      const grnFilter: Record<string, unknown> = {
        tenantId: tid,
        noDO: payload.noDO,
        vendorInvoiceId: { $exists: false },
      };
      const vid = hutangVendorKey(vendorTenantId || hutang.vendorTenantId);
      if (vid) grnFilter.vendorTenantId = vid;
      await txDb.collection('goods_receipts').updateMany(
        grnFilter,
        {
          $set: {
            vendorInvoiceId: invoiceId,
            noInvoice: payload.noInvoice,
            hutangId: hutang.id,
            invoiceSyncStatus: 'DONE',
            invoiceSyncError: null,
            invoiceSyncAt: new Date(),
          },
        },
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

  await markGrnInvoiceSyncDone(db, tid, payload, hutang.id, invoiceId, vendorTenantId);

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

export type CreditNoteApplyOptions = {
  appliedVia?: 'credit-note-posted-push' | 'credit-note-posted-webhook';
  correlationId?: string | null;
};

export async function applyCreditNoteFromVendor(
  db: Db,
  customerTenantId: string,
  payload: VendorInvoicePayload & {
    creditNoteId?: string;
    noCN?: string;
    source?: string;
    noReturn?: string;
  },
  vendorTenantId: string | null | undefined,
  opts: CreditNoteApplyOptions = {},
) {
  const tid = normalizeTenantId(customerTenantId || 'default');
  const invoiceId = String(payload.invoiceId || '').trim();
  const noInvoice = String(payload.noInvoice || '').trim();
  const creditTotal = parseInt(String(payload.total || 0), 10);
  if ((!invoiceId && !noInvoice) || creditTotal <= 0) return { error: 'invoiceId/noInvoice dan total wajib' };

  const creditNoteId = String(payload.creditNoteId || '').trim() || null;
  const vendorTid = vendorTenantId ? String(vendorTenantId).trim() : '';

  let hutang = invoiceId
    ? await db.collection('hutang').findOne({
      ...tenantIdMatchFilter(tid),
      vendorInvoiceId: invoiceId,
      referenceType: 'VENDOR_INVOICE',
    })
    : null;
  if (!hutang && noInvoice) {
    hutang = await db.collection('hutang').findOne({
      ...tenantIdMatchFilter(tid),
      noInvoice,
      referenceType: 'VENDOR_INVOICE',
      ...(vendorTid ? { vendorTenantId: vendorTid } : {}),
    });
  }
  if (!hutang) return { action: 'no_hutang', invoiceId: invoiceId || noInvoice };

  const existingNotes = Array.isArray(hutang.creditNotes) ? hutang.creditNotes : [];
  if (creditNoteId) {
    const already = existingNotes.some(
      (n: { creditNoteId?: string }) => String(n?.creditNoteId || '').trim() === creditNoteId,
    );
    if (already) {
      return { action: 'already_applied' as const, hutangId: hutang.id };
    }
  }

  const reduce = Math.min(creditTotal, hutang.sisa || 0);
  const now = new Date();
  const cnTrail = {
    creditNoteId: payload.creditNoteId,
    noCN: payload.noCN,
    amount: Math.max(0, reduce),
    postedAt: payload.postedAt || now,
    source: payload.source || null,
    noReturn: payload.noReturn || null,
    appliedVia: opts.appliedVia || null,
    correlationId: opts.correlationId ? String(opts.correlationId).trim() || null : null,
    items: Array.isArray(payload.items)
      ? payload.items.map((it) => ({
        lineId: it.lineId,
        stokId: it.stokId,
        uomId: it.uomId,
        satuan: it.satuan,
        qty: it.qty,
        qtyBase: it.qtyBase,
      }))
      : undefined,
  };
  if (reduce <= 0) {
    if (creditNoteId) {
      await db.collection('hutang').updateOne(
        { id: hutang.id, creditNotes: { $not: { $elemMatch: { creditNoteId } } } },
        { $push: { creditNotes: cnTrail }, $set: { updatedAt: now } } as never,
      );
    }
    return { action: 'nothing_to_reduce' as const, hutangId: hutang.id };
  }
  const newTerbayar = (hutang.terbayar || 0) + reduce;
  const newSisa = hutang.total - newTerbayar;
  const fullyPaid = newSisa <= 0;
  const settledStatus = fullyPaid ? 'LUNAS' : hutang.status;
  const settledApproval = fullyPaid
    ? (hutang.approvalStatus === 'APPROVED' || hutang.approvalStatus === 'PARTIAL' ? 'LUNAS' : hutang.approvalStatus)
    : hutang.approvalStatus;
  const cnSourceId = String(payload.creditNoteId || payload.noCN || `${hutang.id}-${now.getTime()}`);

  let claimed = false;
  await runInTransactionOrFallback(async ({ db: txDb, session }) => {
    // Atomic claim: skip if creditNoteId already present (concurrent push/webhook).
    const filter: Record<string, unknown> = { id: hutang.id };
    if (creditNoteId) {
      filter.creditNotes = { $not: { $elemMatch: { creditNoteId } } };
    }
    const upd = await txDb.collection('hutang').updateOne(
      filter,
      {
        $set: {
          terbayar: newTerbayar,
          sisa: newSisa,
          status: fullyPaid ? settledStatus : hutang.status,
          approvalStatus: fullyPaid ? settledApproval : hutang.approvalStatus,
          updatedAt: now,
        },
        $push: {
          creditNotes: cnTrail,
        } as never,
      },
      txOpts(session),
    );
    if (upd.matchedCount === 0) return;
    claimed = true;

    const cnLines = buildCreditNoteHutangJournalLines({
      noDoc: payload.noCN || payload.creditNoteId || 'CN',
      amount: reduce,
    });
    if (cnLines.length) {
      await createJournalIfNotExists(txDb, {
        tanggal: now,
        keterangan: `Credit note vendor ${payload.noCN || payload.creditNoteId}`,
        sourceType: 'AUTO_CN_VENDOR',
        sourceId: cnSourceId,
        userName: opts.appliedVia === 'credit-note-posted-push'
          ? 'credit-note-push'
          : 'credit-note-webhook',
        details: cnLines,
        tenantId: tid,
      }, session);
    }
  });

  if (!claimed) {
    if (creditNoteId) {
      return { action: 'already_applied' as const, hutangId: hutang.id };
    }
    return { action: 'exists' as const, hutangId: hutang.id };
  }

  return {
    action: 'credit_applied',
    hutangId: hutang.id,
    reduced: reduce,
    sisa: newSisa,
    vendorTenantId,
  };
}
