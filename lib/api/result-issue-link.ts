import type { ClientSession, Db, Filter } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import {
  PRODUCTION_RESULTS_COLLECTION,
  RESULT_OPEN_STATUSES,
} from '@/lib/food-production/production-result';
import { MATERIAL_ISSUES_COLLECTION } from '@/lib/food-production/material-issue';

type AnyFilter = Filter<Record<string, unknown>>;

/** HSL yang belum punya tautan PBL. */
export function unlinkedResultFilter(): AnyFilter {
  return {
    $or: [
      { materialIssueId: null },
      { materialIssueId: '' },
      { materialIssueId: { $exists: false } },
    ],
  };
}

export function openUnlinkedResultsFilter(
  tenantFilter: AnyFilter,
  productionPlanId: string,
): AnyFilter {
  return {
    $and: [
      tenantFilter,
      { productionPlanId, status: { $in: [...RESULT_OPEN_STATUSES] } },
      unlinkedResultFilter(),
    ],
  };
}

/** Isi tautan PBL ke HSL terbuka milik rencana yang sama. Mengembalikan jumlah HSL yang diperbarui. */
export async function linkOpenResultsToIssue(
  db: Db,
  tenantFilter: AnyFilter,
  issue: { id: string; noDokumen?: string; productionPlanId?: string },
  now: Date,
  session?: ClientSession | null,
): Promise<number> {
  const planId = String(issue.productionPlanId || '').trim();
  if (!planId || !issue.id) return 0;
  const res = await db.collection(PRODUCTION_RESULTS_COLLECTION).updateMany(
    openUnlinkedResultsFilter(tenantFilter, planId),
    {
      $set: {
        materialIssueId: issue.id,
        materialIssueNo: issue.noDokumen ?? null,
        updatedAt: now,
      },
    },
    txOpts(session ?? undefined),
  );
  return res.modifiedCount;
}

/** PBL COMPLETED terbaru untuk rencana. */
export async function latestCompletedIssueForPlan(
  db: Db,
  tenantFilter: AnyFilter,
  productionPlanId: string,
  session?: ClientSession | null,
): Promise<{ id: string; noDokumen?: string } | null> {
  const row = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
    { $and: [tenantFilter, { productionPlanId, status: 'COMPLETED' }] },
    { ...txOpts(session ?? undefined), sort: { createdAt: -1 }, projection: { id: 1, noDokumen: 1 } },
  );
  if (!row?.id) return null;
  return { id: String(row.id), noDokumen: row.noDokumen != null ? String(row.noDokumen) : undefined };
}
