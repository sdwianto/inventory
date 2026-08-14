// Dashboard inventory-app — PO, stok gudang, belanja pengadaan.

import type { NextResponse } from 'next/server';
import type { Db } from 'mongodb';
import { ok } from '@/lib/api/db';
import { resolveOperationalScope, withTenantFilter } from '@/lib/api/tenant-master';
import { warehouseLabel, WAREHOUSE_CODES } from '@/lib/api/warehouses';
import { fetchMaintenanceDashboardStats } from '@/lib/api/maintenance-dashboard-stats';
import { hutangPendingReviewFilter } from '@/lib/api/hutang-filters';
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';
import { getDashboardSnapshot, setDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import {
  approvedVendorInvoiceMatch,
  buildSpendingMonths,
  foldInventoryByWarehouse,
  grnSummaryFromAgg,
  resolveDashboardUnitCost,
  type GrnStatusAggRow,
  type InventoryStockRow,
  type MonthAggRow,
} from '@/lib/api/dashboard-metrics';

const PO_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Menunggu approval',
  APPROVED: 'Disetujui',
  SUBMITTED: 'Terkirim vendor',
  CONFIRMED: 'SO dikonfirmasi',
  PARTIAL_CANCELLED: 'Batal sebagian',
  CANCELLED: 'Dibatalkan',
  SHIPPED: 'Dikirim',
  PARTIAL_SHIPPED: 'Kirim sebagian',
  RECEIVED: 'Diterima',
  PARTIAL_RECEIVED: 'Terima sebagian',
  INVOICED: 'Invoiced',
  REJECTED: 'Ditolak',
};

const PO_COLORS: Record<string, string> = {
  DRAFT: '#94a3b8',
  PENDING_APPROVAL: '#f59e0b',
  APPROVED: '#3b82f6',
  SUBMITTED: '#6366f1',
  CONFIRMED: '#8b5cf6',
  PARTIAL_CANCELLED: '#e11d48',
  CANCELLED: '#64748b',
  SHIPPED: '#0ea5e9',
  PARTIAL_SHIPPED: '#38bdf8',
  RECEIVED: '#22c55e',
  PARTIAL_RECEIVED: '#86efac',
  INVOICED: '#f97316',
  REJECTED: '#ef4444',
};

async function aggregateInventoryByWarehouse(db: Db, scopeAuth: AuthContext) {
  const stockScope = withTenantFilter(scopeAuth, { lokasiKode: { $in: [...WAREHOUSE_CODES] } });
  const grouped = await db.collection('stok_lokasi').aggregate([
    { $match: stockScope },
    {
      $group: {
        _id: { lokasi: '$lokasiKode', stokId: '$stokId' },
        qty: { $sum: { $ifNull: ['$qty', 0] } },
      },
    },
  ]).toArray();

  const rows: InventoryStockRow[] = grouped.map((r) => ({
    lokasiKode: String(r._id?.lokasi || 'GKERING'),
    stokId: String(r._id?.stokId || ''),
    qty: Number(r.qty) || 0,
  }));

  const stokIds = [...new Set(rows.map((r) => r.stokId).filter(Boolean))];
  const priceMap = new Map<string, number>();
  if (stokIds.length) {
    const products = await db.collection('products')
      .find(withTenantFilter(scopeAuth, { id: { $in: stokIds } }))
      .project({ id: 1, hargaBeli: 1, vendorHargaBeli: 1 })
      .toArray();
    for (const p of products) {
      priceMap.set(String(p.id), resolveDashboardUnitCost(p));
    }
  }

  return foldInventoryByWarehouse(rows, priceMap);
}

export async function handleDashboard({
  db,
  route,
  method,
  auth,
  url,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (route !== '/dashboard' || method !== 'GET') return null;

  const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
  if (denied) return denied;
  if (!scopeAuth) return null;

  const forceRefresh = url.searchParams.get('refresh') === '1';
  if (!forceRefresh) {
    const cached = await getDashboardSnapshot(db, scopeAuth);
    if (cached) return ok(cached);
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const tenantPo = withTenantFilter(scopeAuth, {});
  const tenantGrn = withTenantFilter(scopeAuth, {});
  const tenantProducts = withTenantFilter(scopeAuth, { aktif: true });
  const tenantApprovedHutang = withTenantFilter(scopeAuth, {
    referenceType: 'VENDOR_INVOICE',
    ...approvedVendorInvoiceMatch(),
  });

  const [
    poAgg,
    grnAgg,
    productCount,
    pendingReview,
    approvedMonthAgg,
    inventoryAgg,
    spendingAgg,
    maintenance,
  ] = await Promise.all([
    db.collection('customer_purchase_orders').aggregate([
      { $match: tenantPo },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    db.collection('goods_receipts').aggregate([
      { $match: tenantGrn },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).toArray() as Promise<GrnStatusAggRow[]>,
    db.collection('products').countDocuments(tenantProducts),
    db.collection('hutang').countDocuments(
      withTenantFilter(scopeAuth, hutangPendingReviewFilter()),
    ),
    db.collection('hutang').aggregate([
      { $match: tenantApprovedHutang },
      { $addFields: { expenseDate: { $ifNull: ['$approvedAt', '$tanggal'] } } },
      { $match: { expenseDate: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$total', 0] } } } },
    ]).toArray(),
    aggregateInventoryByWarehouse(db, scopeAuth),
    db.collection('hutang').aggregate([
      { $match: tenantApprovedHutang },
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
    ]).toArray() as Promise<MonthAggRow[]>,
    fetchMaintenanceDashboardStats(db, scopeAuth, now),
  ]);

  const poByStatus = (poAgg as { _id?: string; count: number }[])
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

  const approvedMonthRow = approvedMonthAgg[0] as { total?: number } | undefined;

  const grnSummary = grnSummaryFromAgg(grnAgg);

  const payload = {
    summary: {
      ...grnSummary,
      produk: productCount,
      pendingReview,
      approvedMonth: Math.round(approvedMonthRow?.total || 0),
    },
    poByStatus,
    inventoryByWarehouse,
    spendingByMonth,
    maintenance,
  };

  await setDashboardSnapshot(db, scopeAuth, payload);
  return ok(payload);
}
