import type { Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import { withTenantFilter } from '@/lib/api/tenant-master';
import {
  ASSETS_COLLECTION,
  MAINTENANCE_REQUESTS_COLLECTION,
  WR_STATUS_LABELS,
} from '@/lib/maintenance/constants';
import { countScheduleDueStats } from '@/lib/api/maintenance-schedule-engine';

interface ReleaseLine {
  qty?: number;
  hargaBeli?: number;
}

interface MonthAggRow {
  _id: string;
  total?: number;
}

function monthLabel(ym: string): string {
  const [y, m] = String(ym).split('-');
  const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
  return d.toLocaleDateString('id-ID', { month: 'short', year: '2-digit' });
}

function sumReleaseItemsCost(items: ReleaseLine[] | undefined): number {
  return (items || []).reduce(
    (s, it) => s + (parseFloat(String(it.qty)) || 0) * (parseInt(String(it.hargaBeli || 0), 10)),
    0,
  );
}

function buildCostMonths(now: Date, rows: MonthAggRow[]): { month: string; label: string; total: number }[] {
  const map = Object.fromEntries(rows.map((r) => [r._id, r.total || 0]));
  const months: { month: string; label: string; total: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ month: key, label: monthLabel(key), total: map[key] || 0 });
  }
  return months;
}

export async function fetchMaintenanceDashboardStats(
  db: Db,
  scopeAuth: AuthContext,
  now: Date,
) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const tenantWr = withTenantFilter(scopeAuth, {});
  const tenantAssets = withTenantFilter(scopeAuth, { status: 'IN_REPAIR' });

  const maintenancePos = await db.collection('customer_purchase_orders')
    .find(withTenantFilter(scopeAuth, { maintenanceRequestId: { $exists: true, $ne: null } }))
    .project({ noPO: 1 })
    .toArray();
  const maintenancePoNos = maintenancePos.map((p) => p.noPO).filter(Boolean) as string[];

  const [
    pendingApproval,
    inProgress,
    assetsInRepair,
    closedMonth,
    wrStatusAgg,
    recentOpen,
    releaseCostMonth,
    serviceCostMonth,
    grnCostMonth,
    releaseCostAgg,
    serviceCostAgg,
    grnCostAgg,
  ] = await Promise.all([
    db.collection(MAINTENANCE_REQUESTS_COLLECTION).countDocuments(
      withTenantFilter(scopeAuth, { status: 'PENDING_APPROVAL' }),
    ),
    db.collection(MAINTENANCE_REQUESTS_COLLECTION).countDocuments(
      withTenantFilter(scopeAuth, { status: { $in: ['APPROVED', 'IN_PROGRESS'] } }),
    ),
    db.collection(ASSETS_COLLECTION).countDocuments(tenantAssets),
    db.collection(MAINTENANCE_REQUESTS_COLLECTION).countDocuments(
      withTenantFilter(scopeAuth, {
        status: 'CLOSED',
        closedAt: { $gte: monthStart },
      }),
    ),
    db.collection(MAINTENANCE_REQUESTS_COLLECTION).aggregate([
      { $match: tenantWr },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    db.collection(MAINTENANCE_REQUESTS_COLLECTION)
      .find(withTenantFilter(scopeAuth, { status: { $in: ['APPROVED', 'IN_PROGRESS'] } }))
      .sort({ updatedAt: -1 })
      .limit(5)
      .project({
        id: 1, noWR: 1, judul: 1, assetKode: 1, assetNama: 1,
        status: 1, priority: 1, resolutionType: 1, updatedAt: 1,
      })
      .toArray(),
    db.collection('inventory_releases').find(
      withTenantFilter(scopeAuth, {
        status: 'POSTED',
        maintenanceRequestId: { $exists: true, $ne: null },
        postedAt: { $gte: monthStart },
      }),
    ).project({ items: 1 }).toArray(),
    db.collection('hutang').aggregate([
      {
        $match: withTenantFilter(scopeAuth, {
          referenceType: 'MAINTENANCE_SERVICE',
          createdAt: { $gte: monthStart },
        }),
      },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$total', 0] } } } },
    ]).toArray(),
    maintenancePoNos.length
      ? db.collection('goods_receipts').aggregate([
        {
          $match: withTenantFilter(scopeAuth, {
            status: 'POSTED',
            noPO: { $in: maintenancePoNos },
            postedAt: { $gte: monthStart },
          }),
        },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$receivedTotal', 0] } } } },
      ]).toArray()
      : Promise.resolve([]),
    db.collection('inventory_releases').aggregate([
      {
        $match: withTenantFilter(scopeAuth, {
          status: 'POSTED',
          maintenanceRequestId: { $exists: true, $ne: null },
          postedAt: { $gte: sixMonthsAgo },
        }),
      },
      {
        $project: {
          month: { $dateToString: { format: '%Y-%m', date: '$postedAt' } },
          cost: {
            $sum: {
              $map: {
                input: { $ifNull: ['$items', []] },
                as: 'it',
                in: {
                  $multiply: [
                    { $ifNull: ['$$it.qty', 0] },
                    { $ifNull: ['$$it.hargaBeli', 0] },
                  ],
                },
              },
            },
          },
        },
      },
      { $group: { _id: '$month', total: { $sum: '$cost' } } },
    ]).toArray() as Promise<MonthAggRow[]>,
    db.collection('hutang').aggregate([
      {
        $match: withTenantFilter(scopeAuth, {
          referenceType: 'MAINTENANCE_SERVICE',
          createdAt: { $gte: sixMonthsAgo },
        }),
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          total: { $sum: { $ifNull: ['$total', 0] } },
        },
      },
    ]).toArray() as Promise<MonthAggRow[]>,
    maintenancePoNos.length
      ? db.collection('goods_receipts').aggregate([
        {
          $match: withTenantFilter(scopeAuth, {
            status: 'POSTED',
            noPO: { $in: maintenancePoNos },
            postedAt: { $gte: sixMonthsAgo },
          }),
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$postedAt' } },
            total: { $sum: { $ifNull: ['$receivedTotal', 0] } },
          },
        },
      ]).toArray() as Promise<MonthAggRow[]>
      : Promise.resolve([] as MonthAggRow[]),
  ]);

  const releaseMonthTotal = releaseCostMonth.reduce(
    (s, r) => s + sumReleaseItemsCost(r.items as ReleaseLine[]),
    0,
  );
  const serviceMonthTotal = (serviceCostMonth[0] as { total?: number } | undefined)?.total || 0;
  const poGrnMonthTotal = (grnCostMonth[0] as { total?: number } | undefined)?.total || 0;
  const costMonth = releaseMonthTotal + serviceMonthTotal + poGrnMonthTotal;

  const monthTotals = new Map<string, number>();
  for (const row of releaseCostAgg) {
    monthTotals.set(row._id, (monthTotals.get(row._id) || 0) + (row.total || 0));
  }
  for (const row of serviceCostAgg) {
    monthTotals.set(row._id, (monthTotals.get(row._id) || 0) + (row.total || 0));
  }
  for (const row of grnCostAgg) {
    monthTotals.set(row._id, (monthTotals.get(row._id) || 0) + (row.total || 0));
  }
  const costByMonth = buildCostMonths(now, [...monthTotals.entries()].map(([_id, total]) => ({ _id, total })));

  const pmStats = await countScheduleDueStats(db, withTenantFilter(scopeAuth, {}), now);

  const WR_COLORS: Record<string, string> = {
    DRAFT: '#94a3b8',
    PENDING_APPROVAL: '#f59e0b',
    APPROVED: '#3b82f6',
    IN_PROGRESS: '#6366f1',
    COMPLETED: '#22c55e',
    CLOSED: '#64748b',
    REJECTED: '#ef4444',
    CANCELLED: '#cbd5e1',
  };

  const wrByStatus = (wrStatusAgg as { _id?: string; count: number }[])
    .filter((r) => r.count > 0)
    .map((r) => {
      const status = r._id || 'UNKNOWN';
      return {
        status,
        label: WR_STATUS_LABELS[status as keyof typeof WR_STATUS_LABELS] || status,
        count: r.count,
        fill: WR_COLORS[status] || '#64748b',
      };
    });

  return {
    summary: {
      pendingApproval,
      inProgress,
      assetsInRepair,
      closedMonth,
      costMonth,
    },
    costByResolution: [
      { type: 'PO', label: 'PO Vendor (GRN)', total: poGrnMonthTotal, fill: '#3b82f6' },
      { type: 'INTERNAL', label: 'Release Stok', total: releaseMonthTotal, fill: '#8b5cf6' },
      { type: 'SERVICE', label: 'Jasa Perbaikan', total: serviceMonthTotal, fill: '#f97316' },
    ],
    wrByStatus,
    costByMonth,
    recentOpen,
    pm: pmStats,
  };
}
