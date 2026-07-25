/**
 * W2-25 Detect→Repair — active KA follow-ups on CLOSED/CANCELLED/missing safety cases.
 * Soft only: cancel orphan FUs; never reopen/touch cases.
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { writeAuditLog } from '@/lib/api/audit-log';
import {
  appendKaHistory,
  assertKaStatusTransition,
} from '@/lib/kitchen-assurance/document';
import {
  KA_ACTIVE_FOLLOW_UP_STATUSES,
  KA_FOLLOW_UPS_COLLECTION,
  KA_FOLLOW_UP_TRANSITIONS,
  type KaFollowUpDoc,
  type KaFollowUpStatus,
} from '@/lib/kitchen-assurance/follow-up';
import {
  KA_SAFETY_CASES_COLLECTION,
  type KaCaseStatus,
  type KaSafetyCaseDoc,
} from '@/lib/kitchen-assurance/safety-case';

export const KA_FOLLOW_UP_ORPHAN_RECONCILE_REPORTS_COLLECTION =
  'ka_follow_up_orphan_reconcile_reports';

const HISTORY_NOTE = 'reconcile:orphan-terminal-case';

export type KaFollowUpOrphanMismatchKind =
  | 'FU_ACTIVE_ON_CLOSED_CASE'
  | 'FU_ACTIVE_ON_CANCELLED_CASE'
  | 'FU_ACTIVE_CASE_MISSING';

export type KaFollowUpOrphanMismatch = {
  kind: KaFollowUpOrphanMismatchKind;
  followUpId: string;
  followUpNo?: string;
  followUpStatus: KaFollowUpStatus;
  safetyCaseId?: string;
  caseStatus?: KaCaseStatus;
  detail: string;
};

export type KaFollowUpOrphanRepairAction = {
  kind: KaFollowUpOrphanMismatchKind | 'SKIP_ILLEGAL_TRANSITION' | 'SKIP_RACE';
  followUpId: string;
  followUpNo?: string;
  fromStatus?: string;
  detail: string;
};

export type KaFollowUpOrphanReconcileReport = {
  id: string;
  tenantId: string;
  createdAt: Date;
  summary: {
    scannedFollowUps: number;
    totalMismatch: number;
    activeOnClosed: number;
    activeOnCancelled: number;
    activeCaseMissing: number;
  };
  mismatches: KaFollowUpOrphanMismatch[];
  /** Optional — set on repair before/after Detect inserts only. */
  phase?: string;
  repairActions?: KaFollowUpOrphanRepairAction[];
};

export type KaFollowUpOrphanRepairResult = {
  detectBeforeId: string;
  detectAfterId: string;
  tenantId: string;
  repaired: number;
  skipped: number;
  actions: KaFollowUpOrphanRepairAction[];
  afterSummary: KaFollowUpOrphanReconcileReport['summary'];
  at: string;
};

export async function detectKaFollowUpOrphans(
  db: Db,
  tenantId: string,
  opts?: { limit?: number },
): Promise<KaFollowUpOrphanReconcileReport> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 200);
  const asOf = new Date();

  const fus = (await db
    .collection(KA_FOLLOW_UPS_COLLECTION)
    .find({
      tenantId: tid,
      status: { $in: KA_ACTIVE_FOLLOW_UP_STATUSES },
    })
    .sort({ updatedAt: -1 })
    .limit(500)
    .toArray()) as unknown as KaFollowUpDoc[];

  const caseIds = [
    ...new Set(
      fus
        .map((fu) => String(fu.safetyCaseId || '').trim())
        .filter(Boolean),
    ),
  ];

  const cases = caseIds.length
    ? ((await db
        .collection(KA_SAFETY_CASES_COLLECTION)
        .find({ tenantId: tid, id: { $in: caseIds } })
        .project({ id: 1, status: 1, noDokumen: 1 })
        .toArray()) as unknown as Pick<KaSafetyCaseDoc, 'id' | 'status' | 'noDokumen'>[])
    : [];

  const caseById = new Map(cases.map((c) => [c.id, c]));
  const mismatches: KaFollowUpOrphanMismatch[] = [];

  for (const fu of fus) {
    if (mismatches.length >= limit) break;

    const caseId = String(fu.safetyCaseId || '').trim();
    const linked = caseId ? caseById.get(caseId) : undefined;

    let kind: KaFollowUpOrphanMismatchKind | null = null;
    if (!caseId || !linked) {
      kind = 'FU_ACTIVE_CASE_MISSING';
    } else if (linked.status === 'CLOSED') {
      kind = 'FU_ACTIVE_ON_CLOSED_CASE';
    } else if (linked.status === 'CANCELLED') {
      kind = 'FU_ACTIVE_ON_CANCELLED_CASE';
    }

    if (!kind) continue;

    mismatches.push({
      kind,
      followUpId: fu.id,
      followUpNo: fu.noDokumen,
      followUpStatus: fu.status,
      safetyCaseId: caseId || undefined,
      caseStatus: linked?.status,
      detail:
        kind === 'FU_ACTIVE_CASE_MISSING'
          ? `${fu.noDokumen || fu.id} · active ${fu.status} · case missing/blank`
          : `${fu.noDokumen || fu.id} · active ${fu.status} · case ${linked?.noDokumen || caseId} ${linked?.status}`,
    });
  }

  return {
    id: uuidv4(),
    tenantId: tid,
    createdAt: asOf,
    summary: {
      scannedFollowUps: fus.length,
      totalMismatch: mismatches.length,
      activeOnClosed: mismatches.filter((m) => m.kind === 'FU_ACTIVE_ON_CLOSED_CASE').length,
      activeOnCancelled: mismatches.filter((m) => m.kind === 'FU_ACTIVE_ON_CANCELLED_CASE').length,
      activeCaseMissing: mismatches.filter((m) => m.kind === 'FU_ACTIVE_CASE_MISSING').length,
    },
    mismatches,
  };
}

export async function runKaFollowUpOrphanDetect(
  db: Db,
  tenantId: string,
): Promise<KaFollowUpOrphanReconcileReport> {
  const report = await detectKaFollowUpOrphans(db, tenantId);
  await db.collection(KA_FOLLOW_UP_ORPHAN_RECONCILE_REPORTS_COLLECTION).insertOne(report);
  return report;
}

/**
 * Soft Repair (MASTER):
 * - Cancel orphan active FUs (OPEN|DONE → CANCELLED)
 * - Never reopen/touch safety cases
 */
export async function repairKaFollowUpOrphans(
  db: Db,
  tenantId: string,
): Promise<KaFollowUpOrphanRepairResult> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const at = new Date().toISOString();

  const before = await detectKaFollowUpOrphans(db, tid);
  await db.collection(KA_FOLLOW_UP_ORPHAN_RECONCILE_REPORTS_COLLECTION).insertOne({
    ...before,
    phase: 'detect-before-repair',
  });

  const actions: KaFollowUpOrphanRepairAction[] = [];
  let repaired = 0;
  let skipped = 0;

  for (const m of before.mismatches) {
    const existing = (await db.collection(KA_FOLLOW_UPS_COLLECTION).findOne({
      tenantId: tid,
      id: m.followUpId,
      status: { $in: KA_ACTIVE_FOLLOW_UP_STATUSES },
    })) as KaFollowUpDoc | null;

    if (!existing) {
      skipped += 1;
      actions.push({
        kind: 'SKIP_RACE',
        followUpId: m.followUpId,
        followUpNo: m.followUpNo,
        fromStatus: m.followUpStatus,
        detail: `FU ${m.followUpNo || m.followUpId} no longer OPEN|DONE`,
      });
      continue;
    }

    const gate = assertKaStatusTransition(
      existing.status,
      'CANCELLED',
      KA_FOLLOW_UP_TRANSITIONS as unknown as Record<string, string[]>,
    );
    if (gate) {
      skipped += 1;
      actions.push({
        kind: 'SKIP_ILLEGAL_TRANSITION',
        followUpId: existing.id,
        followUpNo: existing.noDokumen,
        fromStatus: existing.status,
        detail: gate,
      });
      continue;
    }

    const now = new Date();
    const history = appendKaHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: 'CANCELLED',
      userId: 'system',
      userName: 'System',
      note: HISTORY_NOTE,
    });

    const claim = await db.collection(KA_FOLLOW_UPS_COLLECTION).updateOne(
      {
        tenantId: tid,
        id: existing.id,
        status: existing.status,
      },
      {
        $set: {
          status: 'CANCELLED',
          history,
          updatedAt: now,
        },
      },
    );

    if (claim.modifiedCount !== 1) {
      skipped += 1;
      actions.push({
        kind: 'SKIP_RACE',
        followUpId: existing.id,
        followUpNo: existing.noDokumen,
        fromStatus: existing.status,
        detail: `Claim failed for ${existing.noDokumen || existing.id}`,
      });
      continue;
    }

    await writeAuditLog(db, {
      tenantId: tid,
      action: 'KA_FOLLOW_UP_STATUS',
      entityType: 'ka_follow_up',
      entityId: existing.id,
      summary: `Follow-up ${existing.noDokumen} → CANCELLED (orphan reconcile)`,
      userId: 'system',
      userName: 'System',
    });

    repaired += 1;
    actions.push({
      kind: m.kind,
      followUpId: existing.id,
      followUpNo: existing.noDokumen,
      fromStatus: existing.status,
      detail: `Cancelled orphan FU ${existing.noDokumen || existing.id} (${m.kind})`,
    });
  }

  const after = await detectKaFollowUpOrphans(db, tid);
  await db.collection(KA_FOLLOW_UP_ORPHAN_RECONCILE_REPORTS_COLLECTION).insertOne({
    ...after,
    phase: 'detect-after-repair',
    repairActions: actions,
  });

  return {
    detectBeforeId: before.id,
    detectAfterId: after.id,
    tenantId: tid,
    repaired,
    skipped,
    actions,
    afterSummary: after.summary,
    at,
  };
}
