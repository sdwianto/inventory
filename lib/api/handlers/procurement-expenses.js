// Laporan belanja pengadaan — agregasi tagihan vendor yang disetujui.

import { ok } from '@/lib/api/db';
import { requireRole } from '@/lib/api/require-auth';
import { resolveOperationalScope, withTenantFilter } from '@/lib/api/tenant-master';
import { backfillLegacyVendorInvoices } from '@/lib/api/migrate-hutang-approval';
import { backfillHutangVarianceFields, resolveHutangVariance } from '@/lib/api/hutang-variance-enrich';

const REPORT_ROLES = ['ADMIN', 'MASTER'];

function parseDateParam(val, endOfDay = false) {
  if (!val) return null;
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d;
}

function monthKey(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

export async function handleProcurementExpenses({ db, route, method, url, auth, request }) {
  if (route !== '/procurement-expenses' || method !== 'GET') return null;

  const deniedRole = requireRole(auth, REPORT_ROLES);
  if (deniedRole) return deniedRole;

  const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, request });
  if (denied) return denied;

  await backfillLegacyVendorInvoices(db, tenantId);
  await backfillHutangVarianceFields(db, tenantId);

  const from = parseDateParam(url.searchParams.get('from'));
  const to = parseDateParam(url.searchParams.get('to'), true);

  let filter = withTenantFilter(scopeAuth, { referenceType: 'VENDOR_INVOICE' });
  const list = await db.collection('hutang').find(filter).sort({ approvedAt: -1, tanggal: -1 }).limit(2000).toArray();

  const poNos = [...new Set(list.map((h) => h.noPO).filter(Boolean))];
  const poTenant = tenantId;
  const poList = poNos.length
    ? await db.collection('customer_purchase_orders').find({ tenantId: poTenant, noPO: { $in: poNos } }).toArray()
    : [];
  const poByNo = new Map(poList.map((p) => [p.noPO, p]));

  const approvedStatuses = new Set(['APPROVED', 'PAID_EXTERNAL', 'OUTSTANDING', 'PARTIAL', 'LUNAS']);

  const inRange = (h) => {
    const approval = h.approvalStatus || h.status;
    if (!approvedStatuses.has(approval)) return false;
    if (approval === 'PENDING_REVIEW' || approval === 'REJECTED') return false;
    const dt = h.approvedAt ? new Date(h.approvedAt) : new Date(h.tanggal || h.createdAt);
    if (from && dt < from) return false;
    if (to && dt > to) return false;
    return true;
  };

  const pendingReview = list.filter((h) => (h.approvalStatus || h.status) === 'PENDING_REVIEW');
  const approvedRows = list.filter(inRange);

  let approvedTotal = 0;
  let poEstimasiTotal = 0;
  let soTotal = 0;
  let invoiceTotal = 0;
  let grnReceivedTotal = 0;

  const byMonthMap = new Map();
  const rows = [];
  for (const h of approvedRows) {
    const po = h.noPO ? poByNo.get(h.noPO) : null;
    const variance = await resolveHutangVariance(db, h, po);
    const inv = variance.invoiceTotal;
    const poEst = variance.poEstimasiTotal;
    const so = variance.soTotal;
    const grn = variance.grnReceivedTotal || 0;

    approvedTotal += inv;
    poEstimasiTotal += poEst;
    soTotal += so;
    invoiceTotal += inv;
    grnReceivedTotal += grn;

    const mk = monthKey(h.approvedAt || h.tanggal || h.createdAt);
    byMonthMap.set(mk, (byMonthMap.get(mk) || 0) + inv);

    rows.push({
      id: h.id,
      noPO: h.noPO,
      noSO: h.noSO,
      noInvoice: h.noInvoice,
      noDO: h.noDO,
      supplierName: h.supplierName,
      poEstimasiTotal: poEst,
      soTotal: so,
      grnReceivedTotal: grn,
      invoiceTotal: inv,
      variancePoToSo: variance.variancePoToSo,
      varianceSoToInvoice: variance.varianceSoToInvoice,
      varianceGrnToInvoice: variance.varianceGrnToInvoice,
      approvalStatus: h.approvalStatus || h.status,
      approvedAt: h.approvedAt,
      tanggal: h.tanggal,
    });
  }

  const byMonth = [...byMonthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, total]) => ({ month, approvedTotal: total }));

  return ok({
    summary: {
      approvedTotal,
      pendingReviewTotal: pendingReview.reduce((s, h) => s + (h.total || 0), 0),
      pendingReviewCount: pendingReview.length,
      invoiceCount: rows.length,
      poEstimasiTotal,
      soTotal,
      grnReceivedTotal,
      invoiceTotal,
      variancePoToSo: soTotal - poEstimasiTotal,
      varianceSoToInvoice: invoiceTotal - soTotal,
      varianceGrnToInvoice: invoiceTotal - grnReceivedTotal,
    },
    byMonth,
    rows,
    filter: {
      from: from?.toISOString() || null,
      to: to?.toISOString() || null,
    },
  });
}
