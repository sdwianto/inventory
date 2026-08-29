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
import { ISSUE_ELIGIBLE_PLAN_STATUSES } from '@/lib/food-production/material-issue';
import {
  PRODUCTION_PLANS_COLLECTION,
  collectPlanLineRefs,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import { MATERIAL_REQUIREMENTS_COLLECTION } from '@/lib/food-production/material-requirement';
import { RECIPES_COLLECTION } from '@/lib/food-production/recipe';
import { MENUS_COLLECTION } from '@/lib/food-production/menu';
import {
  isExcludedOperationalKeperluan,
  looksLikeProductionKeperluan,
  planDayWindowWib,
} from '@/lib/food-production/production-keperluan';

export {
  isExcludedOperationalKeperluan,
  looksLikeProductionKeperluan,
  planDayWindowWib,
} from '@/lib/food-production/production-keperluan';

export const INVENTORY_RELEASES_COLLECTION = 'inventory_releases';

/** RL statuses where stock has been posted out. */
export const RL_POSTED_STATUSES = ['POSTED'] as const;

export interface PlanOverlapMatch {
  productionPlanId: string;
  productionPlanNo: string;
  planStatus: string;
  overlapQty: number;
  overlapProductCount: number;
}

async function loadPlanRecipeProductIds(
  db: Db,
  scopeAuth: AuthContext | Parameters<typeof withTenantFilter>[0],
  productionPlanId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const mrp = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { productionPlanId }),
    { sort: { createdAt: -1 }, projection: { lines: 1 } },
  ) as { lines?: Array<{ productId?: string }> } | null;
  for (const line of mrp?.lines || []) {
    const pid = String(line.productId || '').trim();
    if (pid) ids.add(pid);
  }
  if (ids.size) return ids;

  const issues = await db.collection(MATERIAL_ISSUES_COLLECTION)
    .find(withTenantFilter(scopeAuth, { productionPlanId }), { projection: { lines: 1 } })
    .toArray();
  for (const issue of issues) {
    for (const line of (issue.lines || []) as Array<{ productId?: string }>) {
      const pid = String(line.productId || '').trim();
      if (pid) ids.add(pid);
    }
  }
  if (ids.size) return ids;

  // Belum ada MRP/PBL — ambil productId dari BOM resep/menu pada baris rencana.
  const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { id: productionPlanId }),
    { projection: { lines: 1 } },
  ) as Pick<ProductionPlanDoc, 'lines'> | null;
  if (!plan?.lines?.length) return ids;

  const { menuIds, recipeIds } = collectPlanLineRefs(plan.lines);
  const recipeIdSet = new Set(recipeIds);
  if (menuIds.length) {
    const menus = await db.collection(MENUS_COLLECTION)
      .find(withTenantFilter(scopeAuth, { id: { $in: menuIds } }))
      .project({ items: 1 })
      .toArray() as Array<{ items?: Array<{ recipeId?: string }> }>;
    for (const menu of menus) {
      for (const item of menu.items || []) {
        const rid = String(item.recipeId || '').trim();
        if (rid) recipeIdSet.add(rid);
      }
    }
  }
  if (!recipeIdSet.size) return ids;

  const recipes = await db.collection(RECIPES_COLLECTION)
    .find(withTenantFilter(scopeAuth, { id: { $in: [...recipeIdSet] } }))
    .project({ lines: 1 })
    .toArray() as Array<{ lines?: Array<{ productId?: string }> }>;
  for (const recipe of recipes) {
    for (const line of recipe.lines || []) {
      const pid = String(line.productId || '').trim();
      if (pid) ids.add(pid);
    }
  }
  return ids;
}

/** Cari rencana eligible yang produk resepnya overlap dengan item release (hari & dapur sama). */
export async function findProductionPlanOverlapsForRelease(
  db: Db,
  scopeAuth: AuthContext | Parameters<typeof withTenantFilter>[0],
  opts: {
    productIds: string[];
    /** Optional qty per productId untuk ranking overlap yang lebih akurat. */
    productQtyById?: Record<string, number>;
    releaseDate?: Date;
    kitchenId?: string;
  },
): Promise<PlanOverlapMatch[]> {
  const releaseProductIds = new Set(opts.productIds.map((id) => String(id || '').trim()).filter(Boolean));
  if (!releaseProductIds.size) return [];

  const releaseDate = opts.releaseDate || new Date();
  const kitchenId = String(opts.kitchenId || '').trim();

  const planFilter: Record<string, unknown> = {
    status: { $in: [...ISSUE_ELIGIBLE_PLAN_STATUSES, 'COMPLETED'] },
  };
  if (kitchenId) planFilter.kitchenId = kitchenId;

  const plans = await db.collection(PRODUCTION_PLANS_COLLECTION)
    .find(withTenantFilter(scopeAuth, planFilter))
    .project({ id: 1, noDokumen: 1, tanggal: 1, status: 1 })
    .toArray() as Array<{ id?: string; noDokumen?: string; tanggal?: string; status?: string }>;

  const matches: PlanOverlapMatch[] = [];
  for (const plan of plans) {
    const planId = String(plan.id || '').trim();
    const planTanggal = String(plan.tanggal || '').slice(0, 10);
    if (!planId || !planTanggal) continue;
    const { start, end } = planDayWindowWib(planTanggal);
    if (releaseDate < start || releaseDate > end) continue;

    const recipeIds = await loadPlanRecipeProductIds(db, scopeAuth, planId);
    if (!recipeIds.size) continue;

    let overlapQty = 0;
    let overlapProductCount = 0;
    for (const pid of releaseProductIds) {
      if (!recipeIds.has(pid)) continue;
      overlapProductCount += 1;
      overlapQty += Number(opts.productQtyById?.[pid]) || 1;
    }
    if (!overlapProductCount) continue;

    matches.push({
      productionPlanId: planId,
      productionPlanNo: String(plan.noDokumen || planId),
      planStatus: String(plan.status || ''),
      overlapQty: roundQty(overlapQty),
      overlapProductCount,
    });
  }

  return matches.sort((a, b) => (
    b.overlapProductCount - a.overlapProductCount
    || b.overlapQty - a.overlapQty
  ));
}

export type InferProductionPlanResult =
  | { productionPlanId: string; productionPlanNo: string; autoLinked: true }
  | { ambiguous: PlanOverlapMatch[] }
  | { planAlreadyCompleted: PlanOverlapMatch[] }
  | { requiresPlan: true }
  | null;

/** Infer / validasi link rencana saat buat RL operasional. */
export async function inferProductionPlanForRelease(
  db: Db,
  scopeAuth: AuthContext | Parameters<typeof withTenantFilter>[0],
  opts: {
    keperluan: string;
    productIds: string[];
    productQtyById?: Record<string, number>;
    releaseDate?: Date;
    kitchenId?: string;
    explicitPlanId?: string;
  },
): Promise<InferProductionPlanResult> {
  const explicit = String(opts.explicitPlanId || '').trim();
  if (explicit) return null;

  if (isExcludedOperationalKeperluan(opts.keperluan)) return null;

  const matches = await findProductionPlanOverlapsForRelease(db, scopeAuth, {
    productIds: opts.productIds,
    productQtyById: opts.productQtyById,
    releaseDate: opts.releaseDate,
    kitchenId: opts.kitchenId,
  });

  const eligible = matches.filter((m) => ISSUE_ELIGIBLE_PLAN_STATUSES.has(m.planStatus));
  const completedOnly = matches.filter((m) => m.planStatus === 'COMPLETED');

  if (eligible.length === 1) {
    return {
      productionPlanId: eligible[0].productionPlanId,
      productionPlanNo: eligible[0].productionPlanNo,
      autoLinked: true,
    };
  }
  if (eligible.length > 1) return { ambiguous: eligible };
  if (!eligible.length && completedOnly.length) return { planAlreadyCompleted: completedOnly };

  if (looksLikeProductionKeperluan(opts.keperluan)) return { requiresPlan: true };

  return null;
}

/** RL POSTED tanpa planId tapi overlap resep rencana (hari/dapur sama) — untuk readiness. */
export async function aggregateOrphanOperationalConsumption(
  db: Db,
  scopeAuth: AuthContext | Parameters<typeof withTenantFilter>[0],
  plan: { id: string; tanggal?: string; kitchenId?: string },
): Promise<Map<string, PlanConsumptionEntry>> {
  const map = new Map<string, PlanConsumptionEntry>();
  const planId = String(plan.id || '').trim();
  const planTanggal = String(plan.tanggal || '').slice(0, 10);
  if (!planId || !planTanggal) return map;

  const recipeIds = await loadPlanRecipeProductIds(db, scopeAuth, planId);
  if (!recipeIds.size) return map;

  const { start, end } = planDayWindowWib(planTanggal);
  // Jangan filter kitchenId di inventory_releases — dokumen RL historis tidak punya field itu.
  const filter: Record<string, unknown> = {
    status: { $in: [...RL_POSTED_STATUSES] },
    $or: [
      { productionPlanId: { $exists: false } },
      { productionPlanId: null },
      { productionPlanId: '' },
    ],
    tanggal: { $gte: start, $lte: end },
  };

  const releases = await db.collection(INVENTORY_RELEASES_COLLECTION)
    .find(withTenantFilter(scopeAuth, filter))
    .project({ noRelease: 1, items: 1, keperluan: 1 })
    .toArray();

  for (const rl of releases) {
    if (isExcludedOperationalKeperluan(String(rl.keperluan || ''))) continue;
    const noRelease = String(rl.noRelease || '');
    for (const it of (rl.items || []) as Array<{ stokId?: string; qtyBase?: number; qty?: number }>) {
      const pid = String(it.stokId || '').trim();
      const qty = Number(it.qtyBase ?? it.qty) || 0;
      if (!pid || !(qty > 0) || !recipeIds.has(pid)) continue;
      addConsumption(map, pid, 'operational', qty, { noRelease });
    }
  }
  return map;
}

function mergeConsumptionMaps(
  base: Map<string, PlanConsumptionEntry>,
  extra: Map<string, PlanConsumptionEntry>,
): Map<string, PlanConsumptionEntry> {
  for (const [pid, entry] of extra) {
    for (const ref of entry.operationalRefs) {
      addConsumption(base, pid, 'operational', ref.qty, { noRelease: ref.noRelease });
    }
  }
  return base;
}

export interface PlanConsumptionSummary {
  qtyFromRl: number;
  qtyFromPbl: number;
  qtyTotal: number;
  rlCount: number;
  pblCompletedCount: number;
}

/** Ringkasan konsumsi bahan per rencana (RL linked + orphan same-day + PBL completed). */
export async function loadPlanConsumptionSummary(
  db: Db,
  scopeAuth: AuthContext | Parameters<typeof withTenantFilter>[0],
  productionPlanId: string,
): Promise<PlanConsumptionSummary> {
  const planId = String(productionPlanId || '').trim();
  const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { id: planId }),
    { projection: { tanggal: 1, kitchenId: 1 } },
  ) as { tanggal?: string; kitchenId?: string } | null;
  const map = await aggregatePlanMaterialConsumption(db, scopeAuth, planId, {
    includeOrphanOperational: true,
    planMeta: plan
      ? { tanggal: plan.tanggal, kitchenId: plan.kitchenId }
      : undefined,
  });
  let qtyFromRl = 0;
  let qtyFromPbl = 0;
  for (const entry of map.values()) {
    qtyFromRl += entry.operational;
    qtyFromPbl += entry.pbl;
  }
  const orphanNos = new Set<string>();
  for (const entry of map.values()) {
    for (const ref of entry.operationalRefs) orphanNos.add(ref.noRelease);
  }
  const [rlCountLinked, pblCompletedCount] = await Promise.all([
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
    rlCount: Math.max(rlCountLinked, orphanNos.size),
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
  opts: {
    excludeIssueId?: string;
    /** Sertakan RL operasional same-day yang belum punya productionPlanId. */
    includeOrphanOperational?: boolean;
    planMeta?: { tanggal?: string; kitchenId?: string };
  } = {},
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

  if (opts.includeOrphanOperational && opts.planMeta) {
    const orphan = await aggregateOrphanOperationalConsumption(db, scopeAuth, {
      id: planId,
      tanggal: opts.planMeta.tanggal,
      kitchenId: opts.planMeta.kitchenId,
    });
    mergeConsumptionMaps(map, orphan);
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
  const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { id: issue.productionPlanId }),
    { projection: { tanggal: 1, kitchenId: 1 } },
  ) as { tanggal?: string; kitchenId?: string } | null;

  const consumption = await aggregatePlanMaterialConsumption(
    db,
    scopeAuth,
    issue.productionPlanId,
    {
      excludeIssueId: issue.id,
      includeOrphanOperational: true,
      planMeta: plan
        ? { tanggal: plan.tanggal, kitchenId: plan.kitchenId }
        : undefined,
    },
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
  planMeta?: { tanggal?: string; kitchenId?: string },
): Promise<MaterialIssueLine[]> {
  const consumption = await aggregatePlanMaterialConsumption(db, scopeAuth, productionPlanId, {
    includeOrphanOperational: true,
    planMeta,
  });

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
