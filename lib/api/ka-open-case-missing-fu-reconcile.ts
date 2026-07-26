/**
 * W2-27 Detect + W2-28 Soft Repair — open KA cases with resolution FOLLOW_UP
 * but zero active FUs. Repair inserts stub OPEN FU; never clears resolution.
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { writeAuditLog } from '@/lib/api/audit-log';
import {
  appendKaHistory,
  KA_DOC_TYPES,
} from '@/lib/kitchen-assurance/document';
import { nextKaDocNumber } from '@/lib/kitchen-assurance/document-number';
import {
  KA_ACTIVE_FOLLOW_UP_STATUSES,
  KA_FOLLOW_UPS_COLLECTION,
  type KaFollowUpDoc,
  type KaFollowUpStatus,
} from '@/lib/kitchen-assurance/follow-up';
import {
  KA_SAFETY_CASES_COLLECTION,
  buildKaResolutionFollowUpStamp,
  type KaCaseStatus,
  type KaSafetyCaseDoc,
} from '@/lib/kitchen-assurance/safety-case';

export const KA_OPEN_CASE_MISSING_FU_RECONCILE_REPORTS_COLLECTION =
  'ka_open_case_missing_fu_reconcile_reports';

const OPEN_CASE_STATUSES: KaCaseStatus[] = ['OPEN', 'IN_PROGRESS', 'PENDING_VERIFY'];
const OPEN_CASE_STATUS_SET = new Set<KaCaseStatus>(OPEN_CASE_STATUSES);

const REPAIR_HISTORY_NOTE = 'reconcile:open-case-missing-fu';
const STUB_FU_DESCRIPTION =
  'Stub follow-up dari Ops Repair W2-28 (open-case missing FU).';

export type KaOpenCaseMissingFuMismatchKind =
  | 'CASE_FOLLOW_UP_ZERO_FU'
  | 'CASE_FOLLOW_UP_ONLY_TERMINAL_FU';

export type KaOpenCaseMissingFuMismatch = {
  kind: KaOpenCaseMissingFuMismatchKind;
  safetyCaseId: string;
  caseNo?: string;
  caseStatus: KaCaseStatus;
  fuTotalCount: number;
  fuActiveCount: number;
  detail: string;
};

export type KaOpenCaseMissingFuRepairAction = {
  kind:
    | KaOpenCaseMissingFuMismatchKind
    | 'SKIP_RACE'
    | 'SKIP_PRECONDITION'
    | 'STAMP_FOLLOW_UP_POINTER';
  safetyCaseId: string;
  caseNo?: string;
  followUpId?: string;
  followUpNo?: string;
  detail: string;
};

function isKaResolutionFollowUpPointerStale(
  resolution: KaSafetyCaseDoc['resolution'],
  fu: { id: string; noDokumen?: string },
): boolean {
  if (!resolution?.followUpId || resolution.followUpId !== fu.id) return true;
  const wantNo = fu.noDokumen || undefined;
  const haveNo = resolution.followUpNo || undefined;
  return wantNo !== haveNo;
}

export type KaOpenCaseMissingFuReconcileReport = {
  id: string;
  tenantId: string;
  createdAt: Date;
  summary: {
    scannedCases: number;
    totalMismatch: number;
    zeroFu: number;
    onlyTerminalFu: number;
  };
  mismatches: KaOpenCaseMissingFuMismatch[];
  /** Optional — set on repair before/after Detect inserts only. */
  phase?: string;
  repairActions?: KaOpenCaseMissingFuRepairAction[];
};

export type KaOpenCaseMissingFuRepairResult = {
  detectBeforeId: string;
  detectAfterId: string;
  tenantId: string;
  repaired: number;
  skipped: number;
  actions: KaOpenCaseMissingFuRepairAction[];
  afterSummary: KaOpenCaseMissingFuReconcileReport['summary'];
  at: string;
};

export async function detectKaOpenCaseMissingFu(
  db: Db,
  tenantId: string,
  opts?: { limit?: number },
): Promise<KaOpenCaseMissingFuReconcileReport> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 200);
  const asOf = new Date();

  const cases = (await db
    .collection(KA_SAFETY_CASES_COLLECTION)
    .find({
      tenantId: tid,
      status: { $in: OPEN_CASE_STATUSES },
      'resolution.type': 'FOLLOW_UP',
    })
    .sort({ updatedAt: -1 })
    .limit(500)
    .toArray()) as unknown as KaSafetyCaseDoc[];

  const caseIds = cases.map((c) => c.id).filter(Boolean);
  const fus = caseIds.length
    ? ((await db
        .collection(KA_FOLLOW_UPS_COLLECTION)
        .find({
          tenantId: tid,
          safetyCaseId: { $in: caseIds },
        })
        .project({ safetyCaseId: 1, status: 1 })
        .toArray()) as unknown as Pick<KaFollowUpDoc, 'safetyCaseId' | 'status'>[])
    : [];

  const totalByCase = new Map<string, number>();
  const activeByCase = new Map<string, number>();
  const activeSet = new Set<KaFollowUpStatus>(KA_ACTIVE_FOLLOW_UP_STATUSES);

  for (const fu of fus) {
    const caseId = String(fu.safetyCaseId || '').trim();
    if (!caseId) continue;
    totalByCase.set(caseId, (totalByCase.get(caseId) || 0) + 1);
    if (activeSet.has(fu.status)) {
      activeByCase.set(caseId, (activeByCase.get(caseId) || 0) + 1);
    }
  }

  const mismatches: KaOpenCaseMissingFuMismatch[] = [];

  for (const row of cases) {
    if (mismatches.length >= limit) break;

    const fuTotalCount = totalByCase.get(row.id) || 0;
    const fuActiveCount = activeByCase.get(row.id) || 0;
    if (fuActiveCount > 0) continue;

    const kind: KaOpenCaseMissingFuMismatchKind =
      fuTotalCount === 0
        ? 'CASE_FOLLOW_UP_ZERO_FU'
        : 'CASE_FOLLOW_UP_ONLY_TERMINAL_FU';

    mismatches.push({
      kind,
      safetyCaseId: row.id,
      caseNo: row.noDokumen,
      caseStatus: row.status,
      fuTotalCount,
      fuActiveCount,
      detail:
        kind === 'CASE_FOLLOW_UP_ZERO_FU'
          ? `${row.noDokumen || row.id} · ${row.status} · resolution FOLLOW_UP · no FU rows`
          : `${row.noDokumen || row.id} · ${row.status} · resolution FOLLOW_UP · ${fuTotalCount} FU none active`,
    });
  }

  return {
    id: uuidv4(),
    tenantId: tid,
    createdAt: asOf,
    summary: {
      scannedCases: cases.length,
      totalMismatch: mismatches.length,
      zeroFu: mismatches.filter((m) => m.kind === 'CASE_FOLLOW_UP_ZERO_FU').length,
      onlyTerminalFu: mismatches.filter((m) => m.kind === 'CASE_FOLLOW_UP_ONLY_TERMINAL_FU').length,
    },
    mismatches,
  };
}

export async function runKaOpenCaseMissingFuDetect(
  db: Db,
  tenantId: string,
): Promise<KaOpenCaseMissingFuReconcileReport> {
  const report = await detectKaOpenCaseMissingFu(db, tenantId);
  await db.collection(KA_OPEN_CASE_MISSING_FU_RECONCILE_REPORTS_COLLECTION).insertOne(report);
  return report;
}

/**
 * Soft Repair (MASTER):
 * - Insert stub OPEN FU for open FOLLOW_UP cases with zero active FU
 * - Soft-stamp resolution.followUpId / followUpNo (dotted $set only; W2-29)
 * - Never clear / mutate resolution.type (esp. never → NONE)
 * - Soft skip on race / precondition fail
 */
export async function repairKaOpenCaseMissingFu(
  db: Db,
  tenantId: string,
): Promise<KaOpenCaseMissingFuRepairResult> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const at = new Date().toISOString();

  const before = await detectKaOpenCaseMissingFu(db, tid);
  await db.collection(KA_OPEN_CASE_MISSING_FU_RECONCILE_REPORTS_COLLECTION).insertOne({
    ...before,
    phase: 'detect-before-repair',
  });

  const actions: KaOpenCaseMissingFuRepairAction[] = [];
  let repaired = 0;
  let skipped = 0;

  for (const m of before.mismatches) {
    const existing = (await db.collection(KA_SAFETY_CASES_COLLECTION).findOne({
      tenantId: tid,
      id: m.safetyCaseId,
    })) as KaSafetyCaseDoc | null;

    if (
      !existing
      || !OPEN_CASE_STATUS_SET.has(existing.status)
      || existing.resolution?.type !== 'FOLLOW_UP'
    ) {
      skipped += 1;
      actions.push({
        kind: 'SKIP_PRECONDITION',
        safetyCaseId: m.safetyCaseId,
        caseNo: m.caseNo,
        detail: `Case ${m.caseNo || m.safetyCaseId} no longer open FOLLOW_UP`,
      });
      continue;
    }

    const activeFu = (await db.collection(KA_FOLLOW_UPS_COLLECTION).findOne(
      {
        tenantId: tid,
        safetyCaseId: existing.id,
        status: { $in: KA_ACTIVE_FOLLOW_UP_STATUSES },
      },
      { projection: { id: 1, noDokumen: 1 } },
    )) as Pick<KaFollowUpDoc, 'id' | 'noDokumen'> | null;

    if (activeFu) {
      if (isKaResolutionFollowUpPointerStale(existing.resolution, activeFu)) {
        const nowStamp = new Date();
        // Soft stamp only — never replace whole resolution / never touch type.
        await db.collection(KA_SAFETY_CASES_COLLECTION).updateOne(
          { tenantId: tid, id: existing.id },
          {
            $set: {
              updatedAt: nowStamp,
              ...buildKaResolutionFollowUpStamp(activeFu),
            },
          },
        );
        repaired += 1;
        actions.push({
          kind: 'STAMP_FOLLOW_UP_POINTER',
          safetyCaseId: existing.id,
          caseNo: existing.noDokumen,
          followUpId: activeFu.id,
          followUpNo: activeFu.noDokumen,
          detail: `Stamped resolution pointer from active FU ${activeFu.noDokumen || activeFu.id}`,
        });
        continue;
      }
      skipped += 1;
      actions.push({
        kind: 'SKIP_PRECONDITION',
        safetyCaseId: existing.id,
        caseNo: existing.noDokumen,
        followUpId: activeFu.id,
        followUpNo: activeFu.noDokumen,
        detail: `Active FU already exists (${activeFu.noDokumen || activeFu.id})`,
      });
      continue;
    }

    const now = new Date();
    const fu: KaFollowUpDoc = {
      id: uuidv4(),
      tenantId: tid,
      noDokumen: await nextKaDocNumber(db, tid, KA_DOC_TYPES.FOLLOW_UP),
      safetyCaseId: existing.id,
      safetyCaseNo: existing.noDokumen,
      category: existing.category,
      kitchenId: existing.kitchenId,
      kitchenNama: existing.kitchenNama,
      title: `Follow-up: ${existing.title}`,
      description: STUB_FU_DESCRIPTION,
      priority: 'MEDIUM',
      evidenceMedia: [],
      status: 'OPEN',
      history: appendKaHistory([], {
        at: now,
        fromStatus: null,
        toStatus: 'OPEN',
        userId: 'system',
        userName: 'System',
        note: REPAIR_HISTORY_NOTE,
      }),
      createdAt: now,
      updatedAt: now,
      createdBy: 'system',
      createdByName: 'System',
    };

    try {
      await db.collection(KA_FOLLOW_UPS_COLLECTION).insertOne(fu);
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 11000) {
        skipped += 1;
        actions.push({
          kind: 'SKIP_RACE',
          safetyCaseId: existing.id,
          caseNo: existing.noDokumen,
          detail: `Duplicate key on stub FU for ${existing.noDokumen || existing.id}`,
        });
        continue;
      }
      throw e;
    }

    const stamp = buildKaResolutionFollowUpStamp(fu);
    if (existing.status === 'OPEN') {
      // Soft bump + stamp — never $unset / rewrite whole resolution.
      await db.collection(KA_SAFETY_CASES_COLLECTION).updateOne(
        { tenantId: tid, id: existing.id, status: 'OPEN' },
        {
          $set: {
            status: 'IN_PROGRESS',
            updatedAt: now,
            history: appendKaHistory(existing.history, {
              at: now,
              fromStatus: 'OPEN',
              toStatus: 'IN_PROGRESS',
              userId: 'system',
              userName: 'System',
              note: `Follow-up ${fu.noDokumen} dibuat (W2-28 repair)`,
            }),
            ...stamp,
          },
        },
      );
    } else {
      await db.collection(KA_SAFETY_CASES_COLLECTION).updateOne(
        { tenantId: tid, id: existing.id },
        {
          $set: {
            updatedAt: now,
            ...stamp,
          },
        },
      );
    }

    await writeAuditLog(db, {
      tenantId: tid,
      action: 'KA_FOLLOW_UP_CREATE',
      entityType: 'ka_follow_up',
      entityId: fu.id,
      summary: `Follow-up ${fu.noDokumen} stub dari ${existing.noDokumen} (missing-FU repair)`,
      userId: 'system',
      userName: 'System',
    });

    repaired += 1;
    actions.push({
      kind: m.kind,
      safetyCaseId: existing.id,
      caseNo: existing.noDokumen,
      followUpId: fu.id,
      followUpNo: fu.noDokumen,
      detail: `Stub OPEN FU ${fu.noDokumen} for ${existing.noDokumen || existing.id} (${m.kind})`,
    });
  }

  const after = await detectKaOpenCaseMissingFu(db, tid);
  await db.collection(KA_OPEN_CASE_MISSING_FU_RECONCILE_REPORTS_COLLECTION).insertOne({
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
