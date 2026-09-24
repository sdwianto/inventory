/**
 * Konsumsi & HPP aktual bahan produksi.
 * Mode PBL acuan (pblReferenceMode + rlFromPoReference): stok keluar hanya lewat RL tertaut rencana;
 * PBL REFERENCE tidak memuat qty keluar. PBL lama (stockPostedAt) tetap dihitung sebagai konsumsi.
 */

import type { Db } from 'mongodb';
import { withTenantFilter } from '@/lib/api/tenant-master';
import { isPblReferenceModeEnabled } from '@/lib/api/feature-flags';
import { sumOutboundKartuBySource } from '@/lib/stock-ledger';
import type { ActualKartuCost } from '@/lib/food-production/cost';
import type { DailyConsumptionPoint } from '@/lib/food-production/forecast';
import {
  MATERIAL_ISSUES_COLLECTION,
  isReferenceIssue,
  type MaterialIssueDoc,
  type MaterialIssueLine,
} from '@/lib/food-production/material-issue';
import { roundQty } from '@/lib/food-production/material-requirement';
import {
  INVENTORY_RELEASES_COLLECTION,
  RL_POSTED_STATUSES,
  loadOperationalReleaseLinesForPlan,
  mergeConsumptionLinesForCost,
} from '@/lib/food-production/material-issue-reconcile';
import {
  PRODUCTION_PLANS_COLLECTION,
  cookDateFromPlanTanggal,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';

type ScopeAuth = Parameters<typeof withTenantFilter>[0];

type ReleaseItemLite = { stokId?: string; qtyBase?: number; qty?: number };
type ReleaseLite = { id: string; productionPlanId?: string; lokasiKode?: string; items?: ReleaseItemLite[] };

function releaseItemQty(it: ReleaseItemLite): number {
  return Number(it.qtyBase ?? it.qty) || 0;
}

export interface PlanActualCostInput {
  referenceMode: boolean;
  issueLines: MaterialIssueLine[];
  productIds: string[];
  kartuCostByProduct?: Map<string, ActualKartuCost>;
}

/**
 * Baris konsumsi aktual rencana untuk analyzeActualCost.
 * Tanpa mode acuan: perilaku lama (PBL Selesai terakhir + RL tertaut, harga master).
 * Mode acuan: PBL ber-stok + RL POSTED, dinilai dari kartu stok (harga saat keluar).
 */
export async function loadPlanActualCostInput(
  db: Db,
  scopeAuth: ScopeAuth,
  plan: Pick<ProductionPlanDoc, 'id' | 'tenantId'>,
): Promise<PlanActualCostInput> {
  const [flagOn, issue] = await Promise.all([
    isPblReferenceModeEnabled(db, plan.tenantId),
    db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { productionPlanId: plan.id, status: 'COMPLETED' }),
      { sort: { createdAt: -1 } },
    ) as Promise<MaterialIssueDoc | null>,
  ]);
  // PBL acuan tetap dinilai dari RL walau flag tenant dimatikan belakangan (qtyIssued-nya selalu 0).
  const referenceMode = flagOn || isReferenceIssue(issue);
  const pblLines = issue && !isReferenceIssue(issue) ? issue.lines || [] : [];
  const rlLines = await loadOperationalReleaseLinesForPlan(db, scopeAuth, plan.id);
  const issueLines = mergeConsumptionLinesForCost(pblLines, rlLines);
  const productIds = [...new Set(issueLines.map((l) => l.productId))];
  if (!referenceMode) return { referenceMode, issueLines, productIds };

  const releases = await db.collection(INVENTORY_RELEASES_COLLECTION)
    .find(withTenantFilter(scopeAuth, {
      productionPlanId: plan.id,
      status: { $in: [...RL_POSTED_STATUSES] },
    }))
    .project({ id: 1, noRelease: 1 })
    .toArray();
  const kartuCostByProduct = await sumOutboundKartuBySource(db, {
    tenantId: plan.tenantId,
    sources: [
      {
        sourceType: 'RELEASE',
        sourceIds: releases.map((r) => String(r.id)),
        docNos: releases.map((r) => String(r.noRelease || '')),
      },
      ...(issue?.stockPostedAt
        ? [{ sourceType: 'FP_ISSUE' as const, sourceIds: [issue.id], docNos: [issue.noDokumen] }]
        : []),
    ],
  });
  return { referenceMode, issueLines, productIds, kartuCostByProduct };
}

export interface ConsumptionWasteLine {
  issueNo?: string;
  productId: string;
  productNama?: string;
  qtyPlanned: number;
  qtyIssued: number;
}

export interface ActualConsumption {
  referenceMode: boolean;
  points: DailyConsumptionPoint[];
  productIds: Set<string>;
  warehouseKodes: Set<string>;
  wasteLines: ConsumptionWasteLine[];
}

/**
 * Titik konsumsi harian (forecast) + baris waste (rekomendasi).
 * Tanpa mode acuan: qtyIssued PBL Selesai (perilaku lama).
 * Mode acuan: PBL ber-stok + RL POSTED tertaut rencana (tanggal = hari masak rencana);
 * waste PBL REFERENCE = acuan vs Σ RL rencana.
 */
export async function loadActualConsumption(
  db: Db,
  scopeAuth: ScopeAuth,
  opts: { tenantId: string; sinceIso: string; kitchenId?: string; issueLimit: number },
): Promise<ActualConsumption> {
  const referenceMode = await isPblReferenceModeEnabled(db, opts.tenantId);
  const kitchenFilter = opts.kitchenId ? { kitchenId: opts.kitchenId } : {};
  const issues = await db.collection(MATERIAL_ISSUES_COLLECTION)
    .find(withTenantFilter(scopeAuth, {
      ...kitchenFilter,
      status: 'COMPLETED',
      tanggal: { $gte: opts.sinceIso },
    }))
    .project({ id: 1, tanggal: 1, lines: 1, warehouseKode: 1, noDokumen: 1, productionPlanId: 1, stockMode: 1 })
    .sort({ tanggal: -1 })
    .limit(opts.issueLimit)
    .toArray() as unknown as MaterialIssueDoc[];

  const out: ActualConsumption = {
    referenceMode,
    points: [],
    productIds: new Set(),
    warehouseKodes: new Set(),
    wasteLines: [],
  };
  const referenceIssues: MaterialIssueDoc[] = [];
  for (const issue of issues) {
    if (isReferenceIssue(issue)) {
      referenceIssues.push(issue);
      continue;
    }
    if (issue.warehouseKode) out.warehouseKodes.add(issue.warehouseKode);
    for (const line of issue.lines || []) {
      const qty = Number(line.qtyIssued) || 0;
      if (!(qty > 0)) continue;
      out.productIds.add(line.productId);
      out.points.push({ tanggal: issue.tanggal, productId: line.productId, qty });
      out.wasteLines.push({
        issueNo: issue.noDokumen,
        productId: line.productId,
        productNama: line.productNama,
        qtyPlanned: Number(line.qtyPlanned) || 0,
        qtyIssued: qty,
      });
    }
  }
  // Flag mati: RL hanya dihitung untuk rencana yang sudah ber-PBL acuan (tanpa itu konsumsinya hilang).
  if (!referenceMode && !referenceIssues.length) return out;

  const cookDateByPlan = new Map<string, string>();
  if (referenceMode) {
    // Rencana tanggal = hari masak + 1 → saring per hari masak.
    const plans = await db.collection(PRODUCTION_PLANS_COLLECTION)
      .find(withTenantFilter(scopeAuth, {
        ...kitchenFilter,
        status: { $ne: 'CANCELLED' },
        tanggal: { $gte: opts.sinceIso },
      }))
      .project({ id: 1, tanggal: 1 })
      .sort({ tanggal: -1 })
      .limit(opts.issueLimit)
      .toArray() as unknown as Array<Pick<ProductionPlanDoc, 'id' | 'tanggal'>>;
    for (const p of plans) {
      const cook = cookDateFromPlanTanggal(p.tanggal);
      if (cook >= opts.sinceIso) cookDateByPlan.set(p.id, cook);
    }
  }
  for (const issue of referenceIssues) {
    if (issue.productionPlanId && !cookDateByPlan.has(issue.productionPlanId)) {
      cookDateByPlan.set(issue.productionPlanId, issue.tanggal);
    }
  }
  if (!cookDateByPlan.size) return out;

  const releases = await db.collection(INVENTORY_RELEASES_COLLECTION)
    .find(withTenantFilter(scopeAuth, {
      productionPlanId: { $in: [...cookDateByPlan.keys()] },
      status: { $in: [...RL_POSTED_STATUSES] },
    }))
    .project({ id: 1, productionPlanId: 1, lokasiKode: 1, items: 1 })
    .toArray() as unknown as ReleaseLite[];

  const rlQtyByPlanProduct = new Map<string, Map<string, number>>();
  for (const rl of releases) {
    const planId = String(rl.productionPlanId || '');
    const tanggal = cookDateByPlan.get(planId);
    if (!tanggal) continue;
    if (rl.lokasiKode) out.warehouseKodes.add(rl.lokasiKode);
    const byProduct = rlQtyByPlanProduct.get(planId) || new Map<string, number>();
    rlQtyByPlanProduct.set(planId, byProduct);
    for (const it of rl.items || []) {
      const pid = String(it.stokId || '').trim();
      const qty = releaseItemQty(it);
      if (!pid || !(qty > 0)) continue;
      out.productIds.add(pid);
      out.points.push({ tanggal, productId: pid, qty });
      byProduct.set(pid, roundQty((byProduct.get(pid) || 0) + qty));
    }
  }

  for (const issue of referenceIssues) {
    const byProduct = rlQtyByPlanProduct.get(String(issue.productionPlanId || '')) || new Map<string, number>();
    for (const line of issue.lines || []) {
      const ids = line.productIds?.length ? line.productIds : [line.productId];
      const qtyIssued = roundQty(ids.reduce((s, id) => s + (byProduct.get(id) || 0), 0));
      const qtyPlanned = Number(line.acuanQty ?? line.qtyPlanned) || 0;
      if (!(qtyIssued > 0) && !(qtyPlanned > 0)) continue;
      out.wasteLines.push({
        issueNo: issue.noDokumen,
        productId: line.productId,
        productNama: line.productNama,
        qtyPlanned,
        qtyIssued,
      });
    }
  }
  return out;
}
