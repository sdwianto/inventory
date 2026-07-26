/**
 * W2-27 Detect — open KA cases with resolution FOLLOW_UP but zero active FUs.
 * Detect-only: persist Ops report; no Repair / no auto-create FU.
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  KA_ACTIVE_FOLLOW_UP_STATUSES,
  KA_FOLLOW_UPS_COLLECTION,
  type KaFollowUpDoc,
  type KaFollowUpStatus,
} from '@/lib/kitchen-assurance/follow-up';
import {
  KA_SAFETY_CASES_COLLECTION,
  type KaCaseStatus,
  type KaSafetyCaseDoc,
} from '@/lib/kitchen-assurance/safety-case';

export const KA_OPEN_CASE_MISSING_FU_RECONCILE_REPORTS_COLLECTION =
  'ka_open_case_missing_fu_reconcile_reports';

const OPEN_CASE_STATUSES: KaCaseStatus[] = ['OPEN', 'IN_PROGRESS', 'PENDING_VERIFY'];

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
