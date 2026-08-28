/**
 * Reconcile Material Issue (PBL) vs prior operational releases (RL) and completed PBL.
 * Enterprise: satu ledger konsumsi per production plan.
 */

import type { Db } from 'mongodb';
import type { MaterialRequirementLine } from '@/lib/food-production/material-requirement';
import { roundQty, ceilProcurementQty } from '@/lib/food-production/material-requirement';
import {
  MATERIAL_ISSUES_COLLECTION,
  type MaterialIssueDoc,
  type MaterialIssueLine,
} from '@/lib/food-production/material-issue';
import { withTenantFilter } from '@/lib/api/tenant-master';
import type { AuthContext } from '@/types/auth';
import { getQtyStokLokasiBatch } from '@/lib/api/stok-lokasi';

export const INVENTORY_RELEASES_COLLECTION = 'inventory_releases';

/** RL statuses where stock has been posted out. */
export const RL_POSTED_STATUSES = ['POSTED'] as const;

const PRODUCTION_KEPERLUAN_RE = /produksi|masak|menu|dapur|porsi|bahan/i;

/** Keperluan RL terlihat untuk bahan produksi — wajib link rencana (server gate). */
export function looksLikeProductionKeperluan(keperluan: string): boolean {
  return PRODUCTION_KEPERLUAN_RE.test(String(keperluan || '').trim());
}

export interface PlanConsumptionSummary {
  qtyFromRl: number;
  qtyFromPbl: number;
  qtyTotal: number;
  rlCount: number;
  pblCompletedCount: number;
}

/** Ringkasan konsumsi bahan per rencana (RL linked + PBL completed). */
export async function loadPlanConsumptionSummary(
  db: Db,
  scopeAuth: AuthContext | Parameters<typeof withTenantFilter>[0],
  productionPlanId: string,
): Promise<PlanConsumptionSummary> {
  const planId = String(productionPlanId || '').trim();
  const map = await aggregatePlanMaterialConsumption(db, scopeAuth, planId);
  let qtyFromRl = 0;
  let qtyFromPbl = 0;
  for (const entry of map.values()) {
    qtyFromRl += entry.operational;
    qtyFromPbl += entry.pbl;
  }
  const [rlCount, pblCompletedCount] = await Promise.all([
    db.collection(INVENTORY_RELEASES_COLLECTION).countDocuments(
      withTenantFilter(scopeAuth, {
        productionPlanId: planId,
        status: { $in: [...RL_POSTED_STATUSES] },
      }),
    ),
    db.collection(MATERIAL_ISSUES_COLLECTION).countDocuments(
      withTenantFilter(scopeAuth, {
        productionPlanId: planId,
        status: 'COMPLETED',
      }),
    ),
  ]);
  qtyFromRl = roundQty(qtyFromRl);
  qtyFromPbl = roundQty(qtyFromPbl);
  return {
    qtyFromRl,
    qtyFromPbl,
    qtyTotal: roundQty(qtyFromRl + qtyFromPbl),
    rlCount,
    pblCompletedCount,
  };
}

export interface PlanConsumptionEntry {
  operational: number;
  pbl: number;
  total: number;
  operationalRefs: Array<{ noRelease: string; qty: number }>;
  pblRefs: Array<{ noDokumen: string; qty: number }>;
}

export interface ReconcileLineView {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  warehouseKode?: string;
  qtyPlanned: number;
  qtyAlreadyIssuedOperational: number;
  qtyAlreadyIssuedPbl: number;
  qtyAlreadyIssued: number;
  qtyRemaining: number;
  qtyOnHand: number;
  suggestedQtyIssued: number;
  operationalRefs: Array<{ noRelease: string; qty: number }>;
  pblRefs: Array<{ noDokumen: string; qty: number }>;
  /** True when current qtyIssued exceeds remaining or on-hand. */
  mismatch: boolean;
}

export interface IssueReconciliation {
  productionPlanId: string;
  issueId: string;
  lines: ReconcileLineView[];
  summary: {
    lineCount: number;
    qtyPlannedTotal: number;
    qtyAlreadyIssuedTotal: number;
    qtyRemainingTotal: number;
    qtyOnHandTotal: number;
    suggestedQtyIssuedTotal: number;
    mismatchCount: number;
  };
}

function addConsumption(
  map: Map<string, PlanConsumptionEntry>,
  productId: string,
  kind: 'operational' | 'pbl',
  qty: number,
  ref: { noRelease?: string; noDokumen?: string },
): void {
  if (!(qty > 0)) return;
  const key = String(productId).trim();
  if (!key) return;
  const prev = map.get(key) || {
    operational: 0,
    pbl: 0,
    total: 0,
    operationalRefs: [],
    pblRefs: [],
  };
  if (kind === 'operational') {
    prev.operational = roundQty(prev.operational + qty);
    if (ref.noRelease) {
      prev.operationalRefs.push({ noRelease: ref.noRelease, qty: roundQty(qty) });
    }
  } else {
    prev.pbl = roundQty(prev.pbl + qty);
    if (ref.noDokumen) {
      prev.pblRefs.push({ noDokumen: ref.noDokumen, qty: roundQty(qty) });
    }
  }
  prev.total = roundQty(prev.operational + prev.pbl);
  map.set(key, prev);
}

/** Aggregate qty already consumed for a plan (RL linked + completed PBL). */
export async function aggregatePlanMaterialConsumption(
  db: Db,
  scopeAuth: AuthContext | Parameters<typeof withTenantFilter>[0],
  productionPlanId: string,
  opts: { excludeIssueId?: string } = {},
): Promise<Map<string, PlanConsumptionEntry>> {
  const map = new Map<string, PlanConsumptionEntry>();
  const planId = String(productionPlanId || '').trim();
  if (!planId) return map;

  const [releases, completedIssues] = await Promise.all([
    db.collection(INVENTORY_RELEASES_COLLECTION)
      .find(withTenantFilter(scopeAuth, {
        productionPlanId: planId,
        status: { $in: [...RL_POSTED_STATUSES] },
      }))
      .project({ noRelease: 1, items: 1 })
      .toArray(),
    db.collection(MATERIAL_ISSUES_COLLECTION)
      .find(withTenantFilter(scopeAuth, {
        productionPlanId: planId,
        status: 'COMPLETED',
        ...(opts.excludeIssueId ? { id: { $ne: opts.excludeIssueId } } : {}),
      }))
      .project({ noDokumen: 1, lines: 1 })
      .toArray(),
  ]);

  for (const rl of releases) {
    const noRelease = String(rl.noRelease || '');
    for (const it of (rl.items || []) as Array<{ stokId?: string; qtyBase?: number; qty?: number }>) {
      const pid = String(it.stokId || '').trim();
      const qty = Number(it.qtyBase ?? it.qty) || 0;
      addConsumption(map, pid, 'operational', qty, { noRelease });
    }
  }

  for (const issue of completedIssues) {
    const noDokumen = String(issue.noDokumen || '');
    for (const line of (issue.lines || []) as MaterialIssueLine[]) {
      const qty = Number(line.qtyIssued) || 0;
      addConsumption(map, line.productId, 'pbl', qty, { noDokumen });
    }
  }

  return map;
}

function suggestedQty(
  qtyPlanned: number,
  alreadyIssued: number,
  qtyOnHand: number,
): number {
  const remaining = Math.max(0, roundQty(qtyPlanned - alreadyIssued));
  const onHand = Math.max(0, roundQty(qtyOnHand));
  return roundQty(Math.min(remaining, onHand));
}

/** Build reconciliation view for an issue's lines vs plan consumption + on-hand. */
export async function buildIssueReconciliation(
  db: Db,
  scopeAuth: AuthContext | Parameters<typeof withTenantFilter>[0],
  issue: Pick<MaterialIssueDoc, 'id' | 'productionPlanId' | 'lines' | 'tenantId'>,
): Promise<IssueReconciliation> {
  const consumption = await aggregatePlanMaterialConsumption(
    db,
    scopeAuth,
    issue.productionPlanId,
    { excludeIssueId: issue.id },
  );

  const whPairs = (issue.lines || []).map((l) => ({
    productId: l.productId,
    warehouseKode: String(l.warehouseKode || '').trim(),
  }));
  const onHandMap = new Map<string, number>();
  const byWh = new Map<string, string[]>();
  for (const p of whPairs) {
    const wh = p.warehouseKode;
    if (!wh) continue;
    const list = byWh.get(wh) || [];
    list.push(p.productId);
    byWh.set(wh, list);
  }
  for (const [wh, ids] of byWh) {
    const batch = await getQtyStokLokasiBatch(db, issue.tenantId, ids, wh);
    for (const [pid, qty] of batch) {
      onHandMap.set(`${pid}:${wh}`, parseFloat(String(qty)) || 0);
    }
  }

  const lines: ReconcileLineView[] = (issue.lines || []).map((l) => {
    const cons = consumption.get(l.productId);
    const qtyAlreadyIssuedOperational = cons?.operational ?? 0;
    const qtyAlreadyIssuedPbl = cons?.pbl ?? 0;
    const qtyAlreadyIssued = roundQty(qtyAlreadyIssuedOperational + qtyAlreadyIssuedPbl);
    const qtyPlanned = roundQty(Number(l.qtyPlanned) || 0);
    const wh = String(l.warehouseKode || '').trim();
    const qtyOnHand = wh
      ? (onHandMap.get(`${l.productId}:${wh}`) ?? 0)
      : 0;
    const qtyRemaining = Math.max(0, roundQty(qtyPlanned - qtyAlreadyIssued));
    const suggestedQtyIssued = suggestedQty(qtyPlanned, qtyAlreadyIssued, qtyOnHand);
    const currentIssued = roundQty(Number(l.qtyIssued) || 0);
    const mismatch = currentIssued > qtyRemaining || currentIssued > qtyOnHand;

    return {
      productId: l.productId,
      productKode: l.productKode,
      productNama: l.productNama,
      satuan: l.satuan,
      warehouseKode: l.warehouseKode,
      qtyPlanned,
      qtyAlreadyIssuedOperational,
      qtyAlreadyIssuedPbl,
      qtyAlreadyIssued,
      qtyRemaining,
      qtyOnHand: roundQty(qtyOnHand),
      suggestedQtyIssued,
      operationalRefs: cons?.operationalRefs ?? [],
      pblRefs: cons?.pblRefs ?? [],
      mismatch,
    };
  });

  const summary = {
    lineCount: lines.length,
    qtyPlannedTotal: roundQty(lines.reduce((s, x) => s + x.qtyPlanned, 0)),
    qtyAlreadyIssuedTotal: roundQty(lines.reduce((s, x) => s + x.qtyAlreadyIssued, 0)),
    qtyRemainingTotal: roundQty(lines.reduce((s, x) => s + x.qtyRemaining, 0)),
    qtyOnHandTotal: roundQty(lines.reduce((s, x) => s + x.qtyOnHand, 0)),
    suggestedQtyIssuedTotal: roundQty(lines.reduce((s, x) => s + x.suggestedQtyIssued, 0)),
    mismatchCount: lines.filter((x) => x.mismatch).length,
  };

  return {
    productionPlanId: issue.productionPlanId,
    issueId: issue.id,
    lines,
    summary,
  };
}

/** Apply suggested qtyIssued to issue lines (preserves metadata). */
export function applyReconciliationToLines(
  issueLines: MaterialIssueLine[],
  reconciliation: IssueReconciliation,
): MaterialIssueLine[] {
  const byProduct = new Map(reconciliation.lines.map((l) => [l.productId, l]));
  return issueLines.map((line) => {
    const view = byProduct.get(line.productId);
    if (!view) return line;
    return {
      ...line,
      qtyIssued: view.suggestedQtyIssued,
    };
  });
}

/** Seed net qty on new issue lines from plan consumption. */
export async function seedNetIssueLines(
  db: Db,
  scopeAuth: AuthContext | Parameters<typeof withTenantFilter>[0],
  productionPlanId: string,
  tenantId: string,
  lines: MaterialIssueLine[],
): Promise<MaterialIssueLine[]> {
  const consumption = await aggregatePlanMaterialConsumption(db, scopeAuth, productionPlanId);

  const whByProduct = new Map<string, string>();
  for (const l of lines) {
    const wh = String(l.warehouseKode || '').trim();
    if (wh) whByProduct.set(l.productId, wh);
  }
  const onHandByKey = new Map<string, number>();
  const byWh = new Map<string, string[]>();
  for (const l of lines) {
    const wh = String(l.warehouseKode || '').trim();
    if (!wh) continue;
    const list = byWh.get(wh) || [];
    list.push(l.productId);
    byWh.set(wh, list);
  }
  for (const [wh, ids] of byWh) {
    const batch = await getQtyStokLokasiBatch(db, tenantId, ids, wh);
    for (const [pid, qty] of batch) {
      onHandByKey.set(`${pid}:${wh}`, parseFloat(String(qty)) || 0);
    }
  }

  return lines.map((line) => {
    const cons = consumption.get(line.productId);
    const already = cons?.total ?? 0;
    const qtyPlanned = roundQty(Number(line.qtyPlanned) || 0);
    const wh = String(line.warehouseKode || '').trim();
    const onHand = wh ? (onHandByKey.get(`${line.productId}:${wh}`) ?? 0) : 0;
    return {
      ...line,
      qtyIssued: suggestedQty(qtyPlanned, already, onHand),
    };
  });
}

/** Load RL issue lines for actual cost rollup (linked to plan). */
export async function loadOperationalReleaseLinesForPlan(
  db: Db,
  scopeAuth: AuthContext | Parameters<typeof withTenantFilter>[0],
  productionPlanId: string,
): Promise<MaterialIssueLine[]> {
  const releases = await db.collection(INVENTORY_RELEASES_COLLECTION)
    .find(withTenantFilter(scopeAuth, {
      productionPlanId: String(productionPlanId).trim(),
      status: { $in: [...RL_POSTED_STATUSES] },
    }))
    .project({ items: 1 })
    .toArray();

  const byProduct = new Map<string, MaterialIssueLine>();
  for (const rl of releases) {
    for (const it of (rl.items || []) as Array<{
      stokId?: string;
      kode?: string;
      nama?: string;
      satuan?: string;
      qtyBase?: number;
      qty?: number;
    }>) {
      const pid = String(it.stokId || '').trim();
      if (!pid) continue;
      const qty = Number(it.qtyBase ?? it.qty) || 0;
      if (!(qty > 0)) continue;
      const prev = byProduct.get(pid);
      if (prev) {
        prev.qtyIssued = roundQty((prev.qtyIssued || 0) + qty);
        prev.qtyPlanned = roundQty((prev.qtyPlanned || 0) + qty);
      } else {
        byProduct.set(pid, {
          productId: pid,
          productKode: it.kode,
          productNama: it.nama,
          satuan: it.satuan,
          qtyPlanned: roundQty(qty),
          qtyIssued: roundQty(qty),
        });
      }
    }
  }
  return [...byProduct.values()];
}

/** Merge PBL + RL consumption lines for actual cost (by productId). */
export function mergeConsumptionLinesForCost(
  pblLines: MaterialIssueLine[],
  rlLines: MaterialIssueLine[],
): MaterialIssueLine[] {
  const byProduct = new Map<string, MaterialIssueLine>();
  for (const line of [...pblLines, ...rlLines]) {
    const prev = byProduct.get(line.productId);
    const qty = roundQty(Number(line.qtyIssued) || 0);
    if (!(qty > 0)) continue;
    if (prev) {
      prev.qtyIssued = roundQty((prev.qtyIssued || 0) + qty);
      prev.qtyPlanned = roundQty((prev.qtyPlanned || 0) + qty);
    } else {
      byProduct.set(line.productId, { ...line, qtyIssued: qty, qtyPlanned: qty });
    }
  }
  return [...byProduct.values()];
}

/** Recalculate qtyNet/shortage after subtracting plan consumption (RL + completed PBL). */
export function applyConsumptionToRequirementLines(
  lines: MaterialRequirementLine[],
  consumption: Map<string, PlanConsumptionEntry>,
): { lines: MaterialRequirementLine[]; summary: { shortageCount: number; qtyNetTotal: number } } {
  const adjusted = lines.map((line) => {
    const already = consumption.get(line.productId)?.total ?? 0;
    const qtyGross = roundQty(Number(line.qtyGross) || 0);
    const qtyOnHand = roundQty(Number(line.qtyOnHand) || 0);
    const needRemaining = Math.max(0, roundQty(qtyGross - already));
    const qtyNet = ceilProcurementQty(Math.max(0, needRemaining - qtyOnHand), line.satuan);
    return {
      ...line,
      qtyGross,
      qtyOnHand,
      qtyNet,
      shortage: qtyNet > 0,
    };
  });
  return {
    lines: adjusted,
    summary: {
      shortageCount: adjusted.filter((l) => l.shortage).length,
      qtyNetTotal: roundQty(adjusted.reduce((s, l) => s + l.qtyNet, 0)),
    },
  };
}
