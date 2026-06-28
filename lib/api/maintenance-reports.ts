import type { Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import { withTenantFilter } from '@/lib/api/tenant-master';
import { MAINTENANCE_REQUESTS_COLLECTION } from '@/lib/maintenance/constants';
import type { MaintenanceRequestDoc } from '@/types/maintenance';

interface ReleaseLine {
  qty?: number;
  hargaBeli?: number;
}

interface WrCostParts {
  po: number;
  internal: number;
  service: number;
}

export interface WrCostRow {
  wrId: string;
  total: number;
  parts: WrCostParts;
}

export function sumReleaseItemsCost(items: ReleaseLine[] | undefined): number {
  return (items || []).reduce(
    (s, it) => s + (parseFloat(String(it.qty)) || 0) * (parseInt(String(it.hargaBeli || 0), 10)),
    0,
  );
}

export function computeMttrHours(wr: MaintenanceRequestDoc): number | null {
  if (wr.status !== 'CLOSED' && wr.status !== 'COMPLETED') return null;
  const end = wr.closedAt || wr.completedAt;
  if (!end) return null;
  const start = wr.startedAt || wr.approvedAt || wr.createdAt;
  if (!start) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return null;
  return Math.round((ms / 3_600_000) * 10) / 10;
}

export function formatMttrLabel(hours: number | null | undefined): string {
  if (hours == null || hours <= 0) return '—';
  if (hours < 24) return `${hours} jam`;
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days} hari`;
}

function monthLabel(ym: string): string {
  const [y, m] = String(ym).split('-');
  const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
  return d.toLocaleDateString('id-ID', { month: 'short', year: '2-digit' });
}

function parseReportRange(fromParam?: string | null, toParam?: string | null, now = new Date()) {
  const to = toParam ? new Date(toParam) : now;
  to.setHours(23, 59, 59, 999);
  const from = fromParam
    ? new Date(fromParam)
    : new Date(now.getFullYear(), now.getMonth() - 5, 1);
  from.setHours(0, 0, 0, 0);
  return { from, to };
}

async function buildWrCostMap(
  db: Db,
  tenantFilter: Record<string, unknown>,
  wrIds: string[],
  poByWrId: Map<string, string>,
): Promise<Map<string, WrCostParts>> {
  const costMap = new Map<string, WrCostParts>();
  for (const id of wrIds) {
    costMap.set(id, { po: 0, internal: 0, service: 0 });
  }
  if (!wrIds.length) return costMap;

  const poNos = [...new Set([...poByWrId.values()])];
  if (poNos.length) {
    const grns = await db.collection('goods_receipts').find({
      ...tenantFilter,
      status: 'POSTED',
      noPO: { $in: poNos },
    }).project({ noPO: 1, receivedTotal: 1 }).toArray();

    const grnCostByPo = new Map<string, number>();
    for (const g of grns) {
      const noPO = String(g.noPO || '');
      grnCostByPo.set(noPO, (grnCostByPo.get(noPO) || 0) + (parseInt(String(g.receivedTotal || 0), 10)));
    }
    for (const [wrId, noPO] of poByWrId.entries()) {
      const parts = costMap.get(wrId)!;
      parts.po = grnCostByPo.get(noPO) || 0;
    }
  }

  const releases = await db.collection('inventory_releases').find({
    ...tenantFilter,
    status: 'POSTED',
    maintenanceRequestId: { $in: wrIds },
  }).project({ maintenanceRequestId: 1, items: 1 }).toArray();

  for (const rel of releases) {
    const wrId = String(rel.maintenanceRequestId || '');
    const parts = costMap.get(wrId);
    if (!parts) continue;
    parts.internal += sumReleaseItemsCost(rel.items as ReleaseLine[]);
  }

  const hutangs = await db.collection('hutang').find({
    ...tenantFilter,
    referenceType: 'MAINTENANCE_SERVICE',
    maintenanceRequestId: { $in: wrIds },
  }).project({ maintenanceRequestId: 1, total: 1 }).toArray();

  for (const h of hutangs) {
    const wrId = String(h.maintenanceRequestId || '');
    const parts = costMap.get(wrId);
    if (!parts) continue;
    parts.service += parseInt(String(h.total || 0), 10);
  }

  return costMap;
}

export interface MaintenanceReportOptions {
  from?: string | null;
  to?: string | null;
  assetId?: string | null;
}

export async function fetchMaintenanceReport(
  db: Db,
  scopeAuth: AuthContext,
  options: MaintenanceReportOptions = {},
  now = new Date(),
) {
  const { from, to } = parseReportRange(options.from, options.to, now);
  const tenantFilter = withTenantFilter(scopeAuth, {});

  let wrFilter: Record<string, unknown> = {
    ...tenantFilter,
    createdAt: { $gte: from, $lte: to },
  };
  if (options.assetId) wrFilter.assetId = options.assetId;

  const wrList = await db.collection(MAINTENANCE_REQUESTS_COLLECTION)
    .find(wrFilter)
    .sort({ createdAt: -1 })
    .limit(2000)
    .toArray() as MaintenanceRequestDoc[];

  const wrIds = wrList.map((w) => String(w.id)).filter(Boolean);

  const pos = wrIds.length
    ? await db.collection('customer_purchase_orders').find({
      ...tenantFilter,
      maintenanceRequestId: { $in: wrIds },
    }).project({ maintenanceRequestId: 1, noPO: 1, id: 1 }).toArray()
    : [];

  const poByWrId = new Map<string, string>();
  for (const po of pos) {
    if (po.maintenanceRequestId && po.noPO) {
      poByWrId.set(String(po.maintenanceRequestId), String(po.noPO));
    }
  }
  for (const wr of wrList) {
    if (wr.linkedPoNo && wr.id) {
      poByWrId.set(String(wr.id), String(wr.linkedPoNo));
    }
  }

  const costMap = await buildWrCostMap(db, tenantFilter, wrIds, poByWrId);

  let totalCost = 0;
  let preventiveCost = 0;
  let correctiveCost = 0;
  let preventiveCount = 0;
  let correctiveCount = 0;
  let closedCount = 0;
  let mttrSum = 0;
  let mttrCount = 0;

  const assetAgg = new Map<string, {
    assetId: string;
    assetKode: string;
    assetNama: string;
    wrCount: number;
    closedCount: number;
    totalCost: number;
    preventiveCount: number;
    correctiveCount: number;
    mttrSum: number;
    mttrCount: number;
  }>();

  const monthAgg = new Map<string, { total: number; preventive: number; corrective: number }>();
  const resolutionAgg = new Map<string, { count: number; cost: number }>();

  const wrRows: {
    id: string;
    noWR: string;
    judul: string;
    assetKode: string;
    assetNama: string;
    sourceType: string;
    resolutionType: string | null;
    status: string;
    cost: number;
    mttrHours: number | null;
    closedAt: string | null;
  }[] = [];

  for (const wr of wrList) {
    const wrId = String(wr.id);
    const parts = costMap.get(wrId) || { po: 0, internal: 0, service: 0 };
    const cost = parts.po + parts.internal + parts.service;
    const source = wr.sourceType === 'PREVENTIVE' ? 'PREVENTIVE' : 'CORRECTIVE';
    const mttr = computeMttrHours(wr);

    totalCost += cost;
    if (source === 'PREVENTIVE') {
      preventiveCount += 1;
      preventiveCost += cost;
    } else {
      correctiveCount += 1;
      correctiveCost += cost;
    }

    if (wr.status === 'CLOSED' || wr.status === 'COMPLETED') {
      closedCount += 1;
      if (mttr != null) {
        mttrSum += mttr;
        mttrCount += 1;
      }
    }

    const resKey = String(wr.resolutionType || 'NONE');
    const resRow = resolutionAgg.get(resKey) || { count: 0, cost: 0 };
    resRow.count += 1;
    resRow.cost += cost;
    resolutionAgg.set(resKey, resRow);

    const created = wr.createdAt ? new Date(wr.createdAt) : now;
    const monthKey = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}`;
    const mRow = monthAgg.get(monthKey) || { total: 0, preventive: 0, corrective: 0 };
    mRow.total += cost;
    if (source === 'PREVENTIVE') mRow.preventive += cost;
    else mRow.corrective += cost;
    monthAgg.set(monthKey, mRow);

    const assetId = String(wr.assetId || '');
    if (assetId) {
      const a = assetAgg.get(assetId) || {
        assetId,
        assetKode: String(wr.assetKode || ''),
        assetNama: String(wr.assetNama || ''),
        wrCount: 0,
        closedCount: 0,
        totalCost: 0,
        preventiveCount: 0,
        correctiveCount: 0,
        mttrSum: 0,
        mttrCount: 0,
      };
      a.wrCount += 1;
      a.totalCost += cost;
      if (source === 'PREVENTIVE') a.preventiveCount += 1;
      else a.correctiveCount += 1;
      if (wr.status === 'CLOSED' || wr.status === 'COMPLETED') {
        a.closedCount += 1;
        if (mttr != null) {
          a.mttrSum += mttr;
          a.mttrCount += 1;
        }
      }
      assetAgg.set(assetId, a);
    }

    if (wr.status === 'CLOSED') {
      wrRows.push({
        id: wrId,
        noWR: String(wr.noWR || ''),
        judul: String(wr.judul || ''),
        assetKode: String(wr.assetKode || ''),
        assetNama: String(wr.assetNama || ''),
        sourceType: source,
        resolutionType: wr.resolutionType || null,
        status: String(wr.status),
        cost,
        mttrHours: mttr,
        closedAt: wr.closedAt ? new Date(wr.closedAt).toISOString() : null,
      });
    }
  }

  const RESOLUTION_LABELS: Record<string, string> = {
    PO: 'PO Vendor',
    INTERNAL: 'Release Stok',
    SERVICE: 'Jasa',
    NONE: 'Belum ditindaklanjuti',
  };

  const byResolution = [...resolutionAgg.entries()]
    .map(([type, row]) => ({
      type,
      label: RESOLUTION_LABELS[type] || type,
      count: row.count,
      cost: row.cost,
      fill: type === 'PO' ? '#3b82f6' : type === 'INTERNAL' ? '#8b5cf6' : type === 'SERVICE' ? '#f97316' : '#94a3b8',
    }))
    .sort((a, b) => b.cost - a.cost);

  const bySource = [
    {
      source: 'PREVENTIVE',
      label: 'Preventif (PM)',
      count: preventiveCount,
      cost: preventiveCost,
      fill: '#8b5cf6',
    },
    {
      source: 'CORRECTIVE',
      label: 'Korektif',
      count: correctiveCount,
      cost: correctiveCost,
      fill: '#f97316',
    },
  ];

  const costByMonth: { month: string; label: string; total: number; preventive: number; corrective: number }[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
  const endMonth = new Date(to.getFullYear(), to.getMonth(), 1);
  while (cursor <= endMonth) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    const row = monthAgg.get(key) || { total: 0, preventive: 0, corrective: 0 };
    costByMonth.push({ month: key, label: monthLabel(key), ...row });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const byAsset = [...assetAgg.values()]
    .map((a) => ({
      ...a,
      avgMttrHours: a.mttrCount ? Math.round((a.mttrSum / a.mttrCount) * 10) / 10 : null,
      avgMttrLabel: formatMttrLabel(a.mttrCount ? a.mttrSum / a.mttrCount : null),
    }))
    .sort((a, b) => b.totalCost - a.totalCost);

  const avgMttrHours = mttrCount ? Math.round((mttrSum / mttrCount) * 10) / 10 : null;

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    summary: {
      totalWr: wrList.length,
      closedWr: closedCount,
      preventiveCount,
      correctiveCount,
      totalCost,
      preventiveCost,
      correctiveCost,
      avgMttrHours,
      avgMttrLabel: formatMttrLabel(avgMttrHours),
    },
    bySource,
    byResolution,
    costByMonth,
    byAsset,
    recentClosed: wrRows.slice(0, 50),
  };
}
