// Pastikan GRN POSTED punya hutang PENDING_REVIEW yang sinkron dengan sales.app.

import { normalizeTenantId, tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import {
  isVendorInvoiceHutang,
  vendorInvoiceNeedsPendingReview,
} from '@/lib/api/hutang-from-vendor';
import { notifyGrnPostedToSales } from '@/lib/api/grn-notify-sales';
import { createHutangFromVendorInvoice } from '@/lib/api/hutang-from-vendor';

async function findVendorHutang(db, tid, grn) {
  if (grn.hutangId) {
    const byId = await db.collection('hutang').findOne({ id: grn.hutangId });
    if (byId) return byId;
  }
  if (grn.vendorInvoiceId) {
    const byInvoice = await db.collection('hutang').findOne({
      vendorInvoiceId: grn.vendorInvoiceId,
      ...tenantIdMatchFilter(tid),
    });
    if (byInvoice) return byInvoice;
    const byInvoiceGlobal = await db.collection('hutang').findOne({
      vendorInvoiceId: grn.vendorInvoiceId,
    });
    if (byInvoiceGlobal) return byInvoiceGlobal;
  }
  if (grn.noInvoice) {
    const byNo = await db.collection('hutang').findOne({
      noInvoice: grn.noInvoice,
      ...tenantIdMatchFilter(tid),
    });
    if (byNo) return byNo;
    return db.collection('hutang').findOne({ noInvoice: grn.noInvoice });
  }
  return null;
}

async function normalizeVendorHutangDoc(db, tid, hutang, grn = null) {
  const patch = {};
  if (!hutang.referenceType && isVendorInvoiceHutang(hutang)) {
    patch.referenceType = 'VENDOR_INVOICE';
  }
  const wantTid = normalizeTenantId(grn?.tenantId || tid);
  const haveTid = normalizeTenantId(hutang.tenantId || '');
  if (haveTid !== wantTid && wantTid) patch.tenantId = wantTid;
  if (!Object.keys(patch).length) return hutang;
  await db.collection('hutang').updateOne(
    { id: hutang.id },
    { $set: { ...patch, updatedAt: new Date() } },
  );
  return { ...hutang, ...patch };
}

async function resetVendorHutangToPendingReview(db, hutang, { total = null } = {}) {
  const nextTotal = total > 0 ? total : (hutang.total || 0);
  await db.collection('hutang').updateOne(
    { id: hutang.id },
    {
      $set: {
        referenceType: 'VENDOR_INVOICE',
        approvalStatus: 'PENDING_REVIEW',
        status: 'PENDING_REVIEW',
        terbayar: 0,
        sisa: nextTotal,
        ...(total > 0 ? { total: nextTotal } : {}),
        updatedAt: new Date(),
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
}

async function fixHutangApprovalIfNeeded(db, hutang, grn = null) {
  const normalized = await normalizeVendorHutangDoc(db, grn?.tenantId, hutang, grn);
  const fromPostedGrn = !!grn;
  const recv = grn ? parseInt(grn.receivedTotal || 0, 10) : 0;
  const totalMismatch = recv > 0 && Math.abs((normalized.total || 0) - recv) > 1;

  if (!vendorInvoiceNeedsPendingReview(normalized, { fromPostedGrn })) {
    if (fromPostedGrn && totalMismatch) {
      await db.collection('hutang').updateOne(
        { id: normalized.id },
        {
          $set: {
            total: recv,
            sisa: Math.max(0, recv - (normalized.terbayar || 0)),
            updatedAt: new Date(),
          },
        },
      );
      return true;
    }
    return false;
  }

  await resetVendorHutangToPendingReview(db, normalized, { total: recv > 0 ? recv : null });
  return true;
}

function calcGrnReceivedTotal(grn) {
  const direct = parseInt(grn?.receivedTotal || 0, 10);
  if (direct > 0) return direct;
  return (grn?.items || []).reduce((s, it) => {
    const qty = parseFloat(it.qtyReceived ?? it.qtyOrdered) || 0;
    const harga = parseInt(it.harga || it.hargaSatuan || it.hargaBeliBaru || 0, 10);
    return s + Math.round(qty * harga);
  }, 0);
}

/** Buat tagihan vendor lokal dari GRN POSTED (fallback jika sales.app / jurnal gagal). */
export async function ensureHutangForPostedGrn(db, tenantId, grn) {
  const tid = normalizeTenantId(grn?.tenantId || tenantId);
  if (!grn || grn.status !== 'POSTED') return { error: 'GRN belum POSTED' };
  if (!grn.noDO) return { error: 'noDO kosong' };

  const existing = await findVendorHutang(db, tid, grn);
  if (existing) return { hutangId: existing.id, action: 'exists', noHutang: existing.noHutang };

  const total = calcGrnReceivedTotal(grn);
  if (total <= 0) return { error: 'Nilai penerimaan GRN kosong' };

  const invoiceId = grn.vendorInvoiceId || `grn-local:${grn.id}`;
  const payload = {
    invoiceId,
    noInvoice: grn.noInvoice || `INV-${grn.noGRN}`,
    noDO: grn.noDO,
    noSO: grn.noSO || null,
    noPO: grn.noPO || null,
    subTotal: total,
    ppn: 0,
    total,
    paymentTerms: 'KREDIT',
    items: (grn.items || []).map((it) => ({
      kode: it.vendorKode || it.localKode,
      qty: parseFloat(it.qtyReceived ?? it.qtyOrdered) || 0,
      harga: parseInt(it.harga || it.hargaSatuan || it.hargaBeliBaru || 0, 10),
    })),
    postedAt: grn.postedAt || new Date(),
  };

  const result = await createHutangFromVendorInvoice(
    db,
    tid,
    payload,
    grn.vendorTenantId,
  );
  if (result.error) return { error: result.error };

  await db.collection('goods_receipts').updateOne(
    { id: grn.id },
    {
      $set: {
        hutangId: result.hutangId,
        vendorInvoiceId: invoiceId,
        noInvoice: payload.noInvoice,
        receivedTotal: total,
      },
    },
  );

  return result;
}

/** Perbaiki tagihan vendor stale — termasuk yang ter-link GRN tapi tenantId/referenceType salah. */
export async function repairStaleVendorHutangs(db, tenantId) {
  const tid = normalizeTenantId(tenantId);
  const seen = new Set();
  let fixed = 0;

  const grns = await db.collection('goods_receipts').find({
    ...tenantIdMatchFilter(tid),
    status: 'POSTED',
  }).sort({ postedAt: -1 }).toArray();

  for (const grn of grns) {
    const hutang = await findVendorHutang(db, tid, grn);
    if (!hutang || seen.has(hutang.id)) continue;
    seen.add(hutang.id);
    if (await fixHutangApprovalIfNeeded(db, hutang, grn)) fixed += 1;
  }

  const rows = await db.collection('hutang').find({
    $or: [
      { referenceType: 'VENDOR_INVOICE', ...tenantIdMatchFilter(tid) },
      { vendorInvoiceId: { $exists: true, $ne: null }, ...tenantIdMatchFilter(tid) },
    ],
  }).toArray();

  for (const hutang of rows) {
    if (seen.has(hutang.id)) continue;
    seen.add(hutang.id);
    if (await fixHutangApprovalIfNeeded(db, hutang)) fixed += 1;
  }

  return fixed;
}

function needsSalesReplay(grn, hutang, { fullSync = false, salesDoSet = null } = {}) {
  if (!grn.noDO && !grn.vendorDeliveryId) return false;
  if (hutang) {
    if (vendorInvoiceNeedsPendingReview(hutang, { fromPostedGrn: true })) return true;
    const recv = parseInt(grn.receivedTotal || 0, 10);
    if (recv > 0 && Math.abs((hutang.total || 0) - recv) > 1) return true;
    return false;
  }
  if (!fullSync) return false;
  if (salesDoSet && grn.noDO && salesDoSet.has(grn.noDO)) return false;
  return true;
}

export async function reconcileVendorHutangFromPostedGrns(db, tenantId, { callSales = false, salesDoSet = null } = {}) {
  const tid = normalizeTenantId(tenantId);
  let fixed = await repairStaleVendorHutangs(db, tid);

  const grns = await db.collection('goods_receipts').find({
    ...tenantIdMatchFilter(tid),
    status: 'POSTED',
    noDO: { $exists: true, $ne: null },
  }).sort({ postedAt: -1 }).limit(300).toArray();

  let created = 0;
  let linked = 0;
  let replayed = 0;
  const salesErrors = [];

  for (const grn of grns) {
    let hutang = await findVendorHutang(db, tid, grn);

    if (hutang) {
      hutang = await normalizeVendorHutangDoc(db, tid, hutang, grn);
      if (await fixHutangApprovalIfNeeded(db, hutang, grn)) {
        hutang = await db.collection('hutang').findOne({ id: hutang.id });
        fixed += 1;
      }
      const hutangTid = normalizeTenantId(hutang.tenantId);
      if (hutangTid !== tid) {
        await db.collection('hutang').updateOne({ id: hutang.id }, { $set: { tenantId: tid } });
        hutang = { ...hutang, tenantId: tid };
        fixed += 1;
      }
      if (grn.hutangId !== hutang.id || grn.noInvoice !== hutang.noInvoice) {
        await db.collection('goods_receipts').updateOne(
          { id: grn.id },
          {
            $set: {
              hutangId: hutang.id,
              noInvoice: hutang.noInvoice || grn.noInvoice,
              vendorInvoiceId: hutang.vendorInvoiceId || grn.vendorInvoiceId,
            },
          },
        );
        linked += 1;
      }
    }

    const doSet = salesDoSet || new Set();
    const fullSync = callSales === true;
    const staleSync = callSales === 'stale' || fullSync;
    if (!staleSync || !needsSalesReplay(grn, hutang, { fullSync, salesDoSet: doSet })) continue;

    const sync = await notifyGrnPostedToSales(db, tid, grn);
    replayed += 1;
    if (sync.error) {
      salesErrors.push({ noDO: grn.noDO, noGRN: grn.noGRN, error: sync.error });
      const local = await ensureHutangForPostedGrn(db, tid, grn);
      if (local.hutangId && local.action === 'created') created += 1;
      else if (local.error) {
        salesErrors.push({ noDO: grn.noDO, noGRN: grn.noGRN, error: `Lokal: ${local.error}` });
      }
      continue;
    }
    if (sync.hutang?.hutangId) {
      if (sync.hutang.action === 'created') created += 1;
      else if (sync.hutang.action === 'refreshed') fixed += 1;
      else linked += 1;
    } else if (!hutang) {
      const local = await ensureHutangForPostedGrn(db, tid, grn);
      if (local.hutangId && local.action === 'created') created += 1;
    }
  }

  let localCreated = 0;
  for (const grn of grns) {
    if (await findVendorHutang(db, tid, grn)) continue;
    const local = await ensureHutangForPostedGrn(db, tid, grn);
    if (local.hutangId && local.action === 'created') {
      localCreated += 1;
      created += 1;
    }
  }

  return { created, fixed, linked, replayed, scanned: grns.length, salesErrors, localCreated };
}

/** One-time / manual backfix: perbaiki hutang dari GRN POSTED + optional replay sales untuk yang belum punya invoice. */
export async function backfixVendorHutangFromPostedGrns(db, tenantId, { replaySales = false } = {}) {
  const tid = normalizeTenantId(tenantId);
  const reconcile = await reconcileVendorHutangFromPostedGrns(db, tid, {
    callSales: replaySales,
  });

  const pending = await db.collection('hutang').countDocuments({
    $or: [
      { referenceType: 'VENDOR_INVOICE', ...tenantIdMatchFilter(tid) },
      { vendorInvoiceId: { $exists: true, $ne: null }, ...tenantIdMatchFilter(tid) },
    ],
    $and: [{
      $or: [
        { approvalStatus: 'PENDING_REVIEW' },
        { status: 'PENDING_REVIEW', approvalStatus: { $exists: false } },
      ],
    }],
  });

  return { ...reconcile, pendingAfter: pending, tenantId: tid };
}
