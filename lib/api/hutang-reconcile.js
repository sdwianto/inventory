// Pastikan GRN POSTED punya hutang PENDING_REVIEW yang sinkron dengan sales.app.

import { normalizeTenantId, tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { notifyGrnPostedToSales } from '@/lib/api/grn-notify-sales';

async function findVendorHutang(db, tid, grn) {
  if (grn.hutangId) {
    const byId = await db.collection('hutang').findOne({ id: grn.hutangId });
    if (byId) return byId;
  }
  if (grn.vendorInvoiceId) {
    const byInvoice = await db.collection('hutang').findOne({
      vendorInvoiceId: grn.vendorInvoiceId,
      referenceType: 'VENDOR_INVOICE',
      ...tenantIdMatchFilter(tid),
    });
    if (byInvoice) return byInvoice;
  }
  if (grn.noInvoice) {
    return db.collection('hutang').findOne({
      noInvoice: grn.noInvoice,
      referenceType: 'VENDOR_INVOICE',
      ...tenantIdMatchFilter(tid),
    });
  }
  return null;
}

async function fixHutangApprovalIfNeeded(db, hutang) {
  const approval = hutang.approvalStatus || hutang.status;
  if (!['PAID_EXTERNAL', 'LUNAS'].includes(approval)) return false;
  if ((hutang.terbayar || 0) > 0 || hutang.paidExternalAt) return false;

  await db.collection('hutang').updateOne(
    { id: hutang.id },
    {
      $set: {
        approvalStatus: 'PENDING_REVIEW',
        status: 'PENDING_REVIEW',
        sisa: hutang.total,
        terbayar: 0,
        updatedAt: new Date(),
      },
    },
  );
  return true;
}

function needsSalesInvoice(grn, hutang, salesDoSet) {
  if (!grn.noDO) return false;
  if (salesDoSet.has(grn.noDO)) return false;
  if (!hutang) return true;
  const approval = hutang.approvalStatus || hutang.status;
  if (['PAID_EXTERNAL', 'LUNAS'].includes(approval) && (hutang.terbayar || 0) === 0) return true;
  return false;
}

export async function reconcileVendorHutangFromPostedGrns(db, tenantId, { callSales = false, salesDoSet = null } = {}) {
  const tid = normalizeTenantId(tenantId);
  const grns = await db.collection('goods_receipts').find({
    ...tenantIdMatchFilter(tid),
    status: 'POSTED',
    noDO: { $exists: true, $ne: null },
  }).sort({ postedAt: -1 }).limit(300).toArray();

  let created = 0;
  let fixed = 0;
  let linked = 0;
  let replayed = 0;
  const salesErrors = [];

  for (const grn of grns) {
    let hutang = await findVendorHutang(db, tid, grn);

    if (hutang) {
      if (await fixHutangApprovalIfNeeded(db, hutang)) {
        hutang = await db.collection('hutang').findOne({ id: hutang.id });
        fixed += 1;
      }
      const hutangTid = normalizeTenantId(hutang.tenantId);
      if (hutangTid !== tid) {
        await db.collection('hutang').updateOne({ id: hutang.id }, { $set: { tenantId: tid } });
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
    if (!callSales || !needsSalesInvoice(grn, hutang, doSet)) continue;

    const sync = await notifyGrnPostedToSales(db, tid, grn);
    replayed += 1;
    if (sync.error) {
      salesErrors.push({ noDO: grn.noDO, noGRN: grn.noGRN, error: sync.error });
      continue;
    }
    if (sync.hutang?.hutangId) {
      if (sync.hutang.action === 'created') created += 1;
      else linked += 1;
    }
  }

  return { created, fixed, linked, replayed, scanned: grns.length, salesErrors };
}
