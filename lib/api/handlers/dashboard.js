// Dashboard inventory-app — PO, stok gudang, belanja pengadaan.

import { ok } from '@/lib/api/db';
import { resolveOperationalScope, withTenantFilter } from '@/lib/api/tenant-master';
import { warehouseLabel, WAREHOUSE_CODES } from '@/lib/api/warehouses';

const PO_STATUS_LABELS = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Menunggu approval',
  APPROVED: 'Disetujui',
  SUBMITTED: 'Terkirim vendor',
  CONFIRMED: 'SO dikonfirmasi',
  SHIPPED: 'Dikirim',
  PARTIAL_SHIPPED: 'Kirim sebagian',
  RECEIVED: 'Diterima',
  PARTIAL_RECEIVED: 'Terima sebagian',
  INVOICED: 'Invoiced',
  REJECTED: 'Ditolak',
};

const PO_COLORS = {
  DRAFT: '#94a3b8',
  PENDING_APPROVAL: '#f59e0b',
  APPROVED: '#3b82f6',
  SUBMITTED: '#6366f1',
  CONFIRMED: '#8b5cf6',
  SHIPPED: '#0ea5e9',
  PARTIAL_SHIPPED: '#38bdf8',
  RECEIVED: '#22c55e',
  PARTIAL_RECEIVED: '#86efac',
  INVOICED: '#f97316',
  REJECTED: '#ef4444',
};

const APPROVED_SPENDING = new Set(['APPROVED', 'PAID_EXTERNAL', 'OUTSTANDING', 'PARTIAL', 'LUNAS']);

function monthLabel(ym) {
  const [y, m] = String(ym).split('-');
  const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
  return d.toLocaleDateString('id-ID', { month: 'short', year: '2-digit' });
}

function buildSpendingMonths(now, aggRows) {
  const map = Object.fromEntries(aggRows.map((r) => [r._id, r]));
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const row = map[key];
    months.push({
      month: key,
      label: monthLabel(key),
      total: row?.total || 0,
      count: row?.count || 0,
    });
  }
  return months;
}

export async function handleDashboard({ db, route, method, auth, url, request }) {
  if (route !== '/dashboard' || method !== 'GET') return null;

  const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
  if (denied) return denied;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const tenantPo = withTenantFilter(scopeAuth, {});
  const tenantGrn = withTenantFilter(scopeAuth, {});
  const tenantProducts = withTenantFilter(scopeAuth, { aktif: true });
  const tenantStok = withTenantFilter(scopeAuth, { lokasiKode: { $in: WAREHOUSE_CODES } });
  const tenantHutang = withTenantFilter(scopeAuth, {
    referenceType: 'VENDOR_INVOICE',
    approvalStatus: { $nin: ['PENDING_REVIEW', 'REJECTED'] },
  });

  const [
    poAgg,
    grnList,
    productCount,
    pendingReview,
    approvedMonthAgg,
    inventoryAgg,
    spendingAgg,
  ] = await Promise.all([
    db.collection('customer_purchase_orders').aggregate([
      { $match: tenantPo },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    db.collection('goods_receipts').find(tenantGrn).project({ status: 1 }).toArray(),
    db.collection('products').countDocuments(tenantProducts),
    db.collection('hutang').countDocuments(
      withTenantFilter(scopeAuth, { referenceType: 'VENDOR_INVOICE', approvalStatus: 'PENDING_REVIEW' }),
    ),
    db.collection('hutang').aggregate([
      {
        $match: {
          ...withTenantFilter(scopeAuth, { referenceType: 'VENDOR_INVOICE' }),
          $or: [
            { approvalStatus: { $in: [...APPROVED_SPENDING] } },
            { status: { $in: [...APPROVED_SPENDING] }, approvalStatus: { $exists: false } },
          ],
        },
      },
      { $addFields: { expenseDate: { $ifNull: ['$approvedAt', '$tanggal'] } } },
      { $match: { expenseDate: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$total', 0] } } } },
    ]).toArray(),
    db.collection('stok_lokasi').aggregate([
      { $match: tenantStok },
      {
        $lookup: {
          from: 'products',
          let: { sid: '$stokId', tid: '$tenantId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$id', '$$sid'] },
                    { $eq: ['$tenantId', '$$tid'] },
                  ],
                },
              },
            },
            { $project: { hargaBeli: 1 } },
          ],
          as: 'prod',
        },
      },
      { $unwind: { path: '$prod', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$lokasiKode',
          qty: { $sum: { $ifNull: ['$qty', 0] } },
          nilai: {
            $sum: {
              $multiply: [
                { $ifNull: ['$qty', 0] },
                { $ifNull: ['$prod.hargaBeli', 0] },
              ],
            },
          },
          skuCount: { $sum: 1 },
        },
      },
    ]).toArray(),
    db.collection('hutang').aggregate([
      { $match: tenantHutang },
      {
        $addFields: {
          expenseDate: { $ifNull: ['$approvedAt', '$tanggal'] },
        },
      },
      { $match: { expenseDate: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$expenseDate' } },
          total: { $sum: { $ifNull: ['$total', 0] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]).toArray(),
  ]);

  const poByStatus = poAgg
    .filter((r) => r.count > 0)
    .map((r) => {
      const status = r._id || 'UNKNOWN';
      return {
        status,
        label: PO_STATUS_LABELS[status] || status,
        count: r.count,
        fill: PO_COLORS[status] || '#64748b',
      };
    });

  const invMap = Object.fromEntries(inventoryAgg.map((r) => [r._id, r]));
  const inventoryByWarehouse = WAREHOUSE_CODES.map((kode) => {
    const row = invMap[kode] || {};
    return {
      kode,
      label: warehouseLabel(kode),
      qty: Math.round((row.qty || 0) * 1000) / 1000,
      nilai: row.nilai || 0,
      skuCount: row.skuCount || 0,
    };
  });

  const spendingByMonth = buildSpendingMonths(now, spendingAgg);

  return ok({
    summary: {
      grn: grnList.length,
      draft: grnList.filter((g) => g.status === 'DRAFT').length,
      unknownProduct: grnList.filter((g) => g.status === 'UNKNOWN_PRODUCT' || g.status === 'NEEDS_MAPPING').length,
      produk: productCount,
      pendingReview,
      approvedMonth: approvedMonthAgg[0]?.total || 0,
    },
    poByStatus,
    inventoryByWarehouse,
    spendingByMonth,
  });
}
