/**
 * W2-9 Detect — Material Issue FEFO shortfall (W2-6 deferred drift).
 * Shortfall does not fail Issue; Detect reports it for Ops / KA.
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  MATERIAL_ISSUES_COLLECTION,
  type MaterialIssueDoc,
} from '@/lib/food-production/material-issue';

export const ISSUE_FEFO_SHORTFALL_REPORTS_COLLECTION = 'issue_fefo_shortfall_reports';

export type IssueFefoShortfallMismatch = {
  kind: 'ISSUE_FEFO_SHORTFALL';
  issueId: string;
  noDokumen?: string;
  stokId: string;
  warehouseKode: string;
  needQty: number;
  allocated: number;
  shortfall: number;
  detail: string;
};

export type IssueFefoShortfallReport = {
  id: string;
  tenantId: string;
  createdAt: Date;
  summary: {
    scannedIssues: number;
    issuesWithShortfall: number;
    totalMismatch: number;
    shortfallQtyTotal: number;
  };
  mismatches: IssueFefoShortfallMismatch[];
};

function isShortfallLine(
  row: NonNullable<MaterialIssueDoc['fefoConsume']>[number],
): boolean {
  if (row.skippedNoLots) return false;
  return Number(row.shortfall || 0) > 0.001;
}

export async function detectIssueFefoShortfalls(
  db: Db,
  tenantId: string,
  opts?: { limit?: number },
): Promise<IssueFefoShortfallReport> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 200);
  const asOf = new Date();

  const issues = (await db
    .collection(MATERIAL_ISSUES_COLLECTION)
    .find({
      tenantId: tid,
      status: 'COMPLETED',
      fefoConsume: { $exists: true, $ne: [] },
    })
    .sort({ updatedAt: -1 })
    .limit(500)
    .toArray()) as unknown as MaterialIssueDoc[];

  const mismatches: IssueFefoShortfallMismatch[] = [];
  const issueIds = new Set<string>();
  let shortfallQtyTotal = 0;

  for (const issue of issues) {
    if (mismatches.length >= limit) break;
    const rows = Array.isArray(issue.fefoConsume) ? issue.fefoConsume : [];
    for (const row of rows) {
      if (mismatches.length >= limit) break;
      if (!isShortfallLine(row)) continue;
      const shortfall = Number(row.shortfall || 0);
      shortfallQtyTotal += shortfall;
      issueIds.add(issue.id);
      mismatches.push({
        kind: 'ISSUE_FEFO_SHORTFALL',
        issueId: issue.id,
        noDokumen: issue.noDokumen,
        stokId: String(row.stokId || ''),
        warehouseKode: String(row.warehouseKode || ''),
        needQty: Number(row.needQty || 0),
        allocated: Number(row.allocated || 0),
        shortfall,
        detail:
          `${issue.noDokumen || issue.id} · need ${row.needQty} allocated ${row.allocated} shortfall ${shortfall}` +
          ` · ${row.stokId}@${row.warehouseKode}`,
      });
    }
  }

  return {
    id: uuidv4(),
    tenantId: tid,
    createdAt: asOf,
    summary: {
      scannedIssues: issues.length,
      issuesWithShortfall: issueIds.size,
      totalMismatch: mismatches.length,
      shortfallQtyTotal,
    },
    mismatches: mismatches.slice(0, limit),
  };
}

export async function runIssueFefoShortfallDetect(
  db: Db,
  tenantId: string,
): Promise<IssueFefoShortfallReport> {
  const report = await detectIssueFefoShortfalls(db, tenantId);
  await db.collection(ISSUE_FEFO_SHORTFALL_REPORTS_COLLECTION).insertOne(report);
  return report;
}
