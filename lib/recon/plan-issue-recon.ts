/**
 * plan-issue-recon (flag `rlFromPoReference`): RL belum tertaut rencana, pemakaian rencana melebihi acuan
 * tanpa alasan yang disetujui, dan PBL lama yang memutasi stok pada rencana yang juga punya RL.
 */

import type { Db } from 'mongodb';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { planFallbackMrpLines } from '@/lib/api/handlers/material-requirements';
import { businessDateIso } from '@/lib/food-production/ingredient-lot';
import { MATERIAL_ISSUES_COLLECTION } from '@/lib/food-production/material-issue';
import { INVENTORY_RELEASES_COLLECTION, RL_POSTED_STATUSES } from '@/lib/food-production/material-issue-reconcile';
import { loadPlanReference } from '@/lib/food-production/plan-reference';
import {
  PLAN_COOK_LEAD_DAYS,
  PRODUCTION_PLANS_COLLECTION,
  shiftIsoDate,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import { getRlOverIssueTolerancePct, type RlOverIssueSnapshot } from '@/lib/food-production/rl-over-issue';
import { RL_LINKABLE_PLAN_STATUSES, listUnlinkedReleases } from '@/lib/food-production/rl-unlinked';
import { qtyGt, roundQty } from '@/lib/stock-ledger/precision';
import { reconScopeAuth } from '@/lib/recon/context';
import type { ReconDetectResult, ReconFinding } from '@/lib/recon/types';

export const PLAN_ISSUE_WINDOW_DAYS = 14;

type ReleaseRow = { id?: string; noRelease?: string; overIssue?: RlOverIssueSnapshot };

export async function detectPlanIssueRecon(
  db: Db,
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<ReconDetectResult> {
  if (!(await isTenantFeatureEnabled(db, tenantId, 'rlFromPoReference'))) {
    return { findings: [], skippedReason: 'Flag rlFromPoReference belum aktif' };
  }
  const now = opts.now ?? new Date();
  const to = businessDateIso(now);
  const from = shiftIsoDate(to, -PLAN_ISSUE_WINDOW_DAYS) || to;
  const scope = reconScopeAuth(tenantId);
  const findings: ReconFinding[] = [];

  const unlinked = await listUnlinkedReleases(db, scope, { from, to, limit: 500 });
  for (const rl of unlinked) {
    const best = rl.candidates[0];
    findings.push({
      kind: 'RL_UNLINKED',
      refType: 'RELEASE',
      refId: rl.id,
      refNo: rl.noRelease,
      detail: `RL ${rl.noRelease} (${rl.keperluan || 'tanpa keperluan'}) belum tertaut rencana`
        + (best ? ` — kandidat ${best.productionPlanNo}` : ''),
    });
  }

  const planTo = shiftIsoDate(to, PLAN_COOK_LEAD_DAYS) || to;
  const plans = await db.collection(PRODUCTION_PLANS_COLLECTION)
    .find({
      tenantId,
      status: { $in: [...RL_LINKABLE_PLAN_STATUSES] },
      tanggal: { $gte: from, $lte: `${planTo}\uffff` },
    })
    .toArray() as unknown as ProductionPlanDoc[];
  const tolerancePct = await getRlOverIssueTolerancePct(db, tenantId);
  const factor = 1 + tolerancePct / 100;
  const plansWithRl: ProductionPlanDoc[] = [];

  for (const plan of plans) {
    const releases = await db.collection(INVENTORY_RELEASES_COLLECTION)
      .find({ tenantId, productionPlanId: plan.id, status: { $in: [...RL_POSTED_STATUSES] } })
      .project({ id: 1, noRelease: 1, overIssue: 1 })
      .toArray() as unknown as ReleaseRow[];
    if (!releases.length) continue;
    plansWithRl.push(plan);

    const approved = new Set<string>();
    for (const rl of releases) {
      for (const l of rl.overIssue?.lines || []) {
        if (l.productId && (l.reasons || []).length) approved.add(String(l.productId));
      }
    }
    const reference = await loadPlanReference(db, scope, { id: plan.id, tenantId }, {
      fallbackMrpLines: await planFallbackMrpLines(db, scope, plan),
    });
    const planNo = String(plan.noDokumen || plan.id);
    for (const line of reference.lines) {
      const consumed = roundQty(line.rlPosted + line.pblPosted);
      const limit = roundQty(line.acuanQty * factor);
      if (!qtyGt(consumed, limit)) continue;
      const ids = [line.productId, ...line.productIds, ...(line.aliasProductIds || [])];
      if (ids.some((id) => approved.has(id))) continue;
      const sat = line.satuan ? ` ${line.satuan}` : '';
      findings.push({
        kind: 'RL_OVER_REFERENCE_UNAPPROVED',
        refType: 'PLAN',
        refId: plan.id,
        refNo: planNo,
        productId: line.productId,
        kode: line.productKode,
        nama: line.productNama,
        expected: line.acuanQty,
        actual: consumed,
        delta: roundQty(consumed - line.acuanQty),
        detail: `${planNo} ${line.productNama || line.productKode || line.productId}: keluar ${consumed}${sat}`
          + ` > batas ${limit}${sat} (acuan ${line.sumber === 'NONE' ? 'tidak ada' : `${line.sumber} ${line.acuanQty}`}`
          + `, toleransi ${tolerancePct}%) tanpa alasan disetujui`,
      });
    }
  }

  if (plansWithRl.length) {
    const planNoById = new Map(plansWithRl.map((p) => [p.id, String(p.noDokumen || p.id)]));
    const issues = await db.collection(MATERIAL_ISSUES_COLLECTION)
      .find({
        tenantId,
        productionPlanId: { $in: [...planNoById.keys()] },
        status: 'COMPLETED',
        stockMode: { $ne: 'REFERENCE' },
        stockPostedAt: { $exists: true, $ne: null },
      })
      .project({ id: 1, noDokumen: 1, productionPlanId: 1 })
      .toArray();
    for (const pbl of issues) {
      const planNo = planNoById.get(String(pbl.productionPlanId)) || String(pbl.productionPlanId);
      findings.push({
        kind: 'PBL_MUTATING_WITH_RL',
        refType: 'MATERIAL_ISSUE',
        refId: String(pbl.id),
        refNo: String(pbl.noDokumen || pbl.id),
        detail: `PBL ${pbl.noDokumen || pbl.id} memotong stok pada ${planNo} yang juga punya RL POSTED — risiko pemakaian ganda`,
      });
    }
  }

  return {
    findings,
    meta: { windowFrom: from, windowTo: to, plansScanned: plans.length, plansWithRl: plansWithRl.length, tolerancePct },
  };
}
