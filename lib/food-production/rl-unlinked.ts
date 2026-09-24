/**
 * Worklist "RL belum tertaut" (Fase 1.3, flag `rlFromPoReference`).
 * RL POSTED tanpa rencana yang keperluannya produksi atau barangnya cocok resep rencana di hari yang sama.
 * Tidak ada atribusi otomatis — penautan dilakukan manual dengan alasan dan audit.
 */

import type { Db } from 'mongodb';
import { withTenantFilter } from '@/lib/api/tenant-master';
import { ISSUE_ELIGIBLE_PLAN_STATUSES } from '@/lib/food-production/material-issue';
import {
  PLAN_COOK_LEAD_DAYS,
  PRODUCTION_PLANS_COLLECTION,
  shiftIsoDate,
} from '@/lib/food-production/production-plan';
import {
  INVENTORY_RELEASES_COLLECTION,
  RL_POSTED_STATUSES,
  isExcludedOperationalKeperluan,
  loadPlanRecipeProductIds,
  looksLikeProductionKeperluan,
  planDayWindowWib,
} from '@/lib/food-production/material-issue-reconcile';
import { roundQty } from '@/lib/stock-ledger/precision';

type ScopeAuth = Parameters<typeof withTenantFilter>[0];

/** Rencana yang boleh menerima tautan manual (termasuk yang sudah selesai, untuk koreksi HPP). */
export const RL_LINKABLE_PLAN_STATUSES = [...ISSUE_ELIGIBLE_PLAN_STATUSES, 'COMPLETED'] as const;

export const RL_UNLINKED_MAX_RANGE_DAYS = 92;

/** Filter RL POSTED tanpa tautan rencana yang belum ditandai bukan produksi. */
export function unlinkedReleaseFilter(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    status: { $in: [...RL_POSTED_STATUSES] },
    $or: [
      { productionPlanId: { $exists: false } },
      { productionPlanId: null },
      { productionPlanId: '' },
    ],
    planLinkDismissedAt: { $exists: false },
  };
}

export interface UnlinkedReleaseCandidate {
  productionPlanId: string;
  productionPlanNo: string;
  planStatus: string;
  tanggal: string;
  overlapProductCount: number;
  overlapQty: number;
}

export interface UnlinkedReleaseRow {
  id: string;
  noRelease: string;
  tanggal?: Date | string;
  keperluan?: string;
  lokasiKode?: string;
  lokasiNama?: string;
  createdBy?: { userId?: string; userName?: string };
  approvedBy?: { userId?: string; userName?: string };
  items: Array<{ stokId: string; kode?: string; nama?: string; qty: number; satuan?: string; qtyBase: number }>;
  looksProduction: boolean;
  candidates: UnlinkedReleaseCandidate[];
}

type ReleaseRow = {
  id?: string;
  noRelease?: string;
  tanggal?: Date | string;
  keperluan?: string;
  lokasiKode?: string;
  lokasiNama?: string;
  kitchenId?: string;
  createdBy?: { userId?: string; userName?: string };
  approvedBy?: { userId?: string; userName?: string };
  items?: Array<{ stokId?: string; kode?: string; nama?: string; qty?: number; qtyBase?: number; satuan?: string }>;
};

type PlanRow = { id?: string; noDokumen?: string; tanggal?: string; status?: string; kitchenId?: string };

/** Tanggal WIB (YYYY-MM-DD) dari waktu RL. */
function wibDay(value: Date | string | undefined): string {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export async function listUnlinkedReleases(
  db: Db,
  scopeAuth: ScopeAuth,
  opts: { from: string; to: string; kitchenId?: string; limit?: number },
): Promise<UnlinkedReleaseRow[]> {
  const from = planDayWindowWib(opts.from).start;
  const to = planDayWindowWib(opts.to).end;
  const limit = Math.min(Math.max(1, opts.limit ?? 200), 500);

  const releases = await db.collection(INVENTORY_RELEASES_COLLECTION)
    .find(withTenantFilter(scopeAuth, unlinkedReleaseFilter({ tanggal: { $gte: from, $lte: to } })))
    .project({
      id: 1, noRelease: 1, tanggal: 1, keperluan: 1, lokasiKode: 1, lokasiNama: 1,
      kitchenId: 1, createdBy: 1, approvedBy: 1, items: 1,
    })
    .sort({ tanggal: -1 })
    .limit(limit)
    .toArray() as unknown as ReleaseRow[];
  if (!releases.length) return [];

  // Rencana tanggal D dimasak D-1, jadi RL hari D-1 juga kandidat rencana hari D.
  const planTo = shiftIsoDate(opts.to, PLAN_COOK_LEAD_DAYS) || opts.to.slice(0, 10);
  const planFilter: Record<string, unknown> = {
    status: { $in: [...RL_LINKABLE_PLAN_STATUSES] },
    tanggal: { $gte: opts.from.slice(0, 10), $lte: `${planTo}\uffff` },
  };
  const kitchenId = String(opts.kitchenId || '').trim();
  if (kitchenId) planFilter.kitchenId = kitchenId;
  const plans = await db.collection(PRODUCTION_PLANS_COLLECTION)
    .find(withTenantFilter(scopeAuth, planFilter))
    .project({ id: 1, noDokumen: 1, tanggal: 1, status: 1, kitchenId: 1 })
    .toArray() as unknown as PlanRow[];

  const plansByDay = new Map<string, PlanRow[]>();
  for (const p of plans) {
    const day = String(p.tanggal || '').slice(0, 10);
    if (!p.id || !day) continue;
    plansByDay.set(day, [...(plansByDay.get(day) || []), p]);
  }
  const recipeCache = new Map<string, Promise<Set<string>>>();
  const recipeIdsOf = (planId: string) => {
    let hit = recipeCache.get(planId);
    if (!hit) {
      hit = loadPlanRecipeProductIds(db, scopeAuth, planId);
      recipeCache.set(planId, hit);
    }
    return hit;
  };

  const rows: UnlinkedReleaseRow[] = [];
  for (const rl of releases) {
    const keperluan = String(rl.keperluan || '');
    const looksProduction = looksLikeProductionKeperluan(keperluan);
    if (!looksProduction && isExcludedOperationalKeperluan(keperluan)) continue;

    const items = (rl.items || [])
      .filter((it) => it.stokId)
      .map((it) => ({
        stokId: String(it.stokId),
        kode: it.kode,
        nama: it.nama,
        qty: roundQty(Number(it.qty) || 0),
        satuan: it.satuan,
        qtyBase: roundQty(Number(it.qtyBase ?? it.qty) || 0),
      }));

    const candidates: UnlinkedReleaseCandidate[] = [];
    const rlDay = wibDay(rl.tanggal);
    const dayPlans = [
      ...(plansByDay.get(rlDay) || []),
      ...(plansByDay.get(shiftIsoDate(rlDay, PLAN_COOK_LEAD_DAYS)) || []),
    ];
    for (const plan of dayPlans) {
      if (rl.kitchenId && plan.kitchenId && rl.kitchenId !== plan.kitchenId) continue;
      const recipeIds = await recipeIdsOf(String(plan.id));
      let overlapProductCount = 0;
      let overlapQty = 0;
      for (const it of items) {
        if (!recipeIds.has(it.stokId)) continue;
        overlapProductCount += 1;
        overlapQty += it.qtyBase;
      }
      if (!overlapProductCount) continue;
      candidates.push({
        productionPlanId: String(plan.id),
        productionPlanNo: String(plan.noDokumen || plan.id),
        planStatus: String(plan.status || ''),
        tanggal: String(plan.tanggal || '').slice(0, 10),
        overlapProductCount,
        overlapQty: roundQty(overlapQty),
      });
    }
    if (!candidates.length && !looksProduction) continue;

    candidates.sort((a, b) => b.overlapProductCount - a.overlapProductCount || b.overlapQty - a.overlapQty);
    rows.push({
      id: String(rl.id || ''),
      noRelease: String(rl.noRelease || ''),
      tanggal: rl.tanggal,
      keperluan: rl.keperluan,
      lokasiKode: rl.lokasiKode,
      lokasiNama: rl.lokasiNama,
      createdBy: rl.createdBy,
      approvedBy: rl.approvedBy,
      items,
      looksProduction,
      candidates,
    });
  }
  return rows;
}
