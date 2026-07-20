/**
 * Kitchen Assurance Reports — ADR-002 P4.
 * Period summary per 4 pillars (not a BI suite).
 */

import type { Db } from 'mongodb';
import {
  KA_PILLARS,
  KA_PILLAR_LABELS,
  toPillar,
  type KaPillar,
} from '@/lib/kitchen-assurance/categories';
import { KA_SAFETY_CASES_COLLECTION } from '@/lib/kitchen-assurance/safety-case';
import { KA_FOLLOW_UPS_COLLECTION } from '@/lib/kitchen-assurance/follow-up';
import {
  TEMPERATURE_LOGS_COLLECTION,
} from '@/lib/food-production/temperature-log';
import { MAINTENANCE_SCHEDULES_COLLECTION } from '@/lib/maintenance/constants';
import { assetIdsForKitchen } from '@/lib/kitchen-assurance/kitchen-assets';

export interface KaPillarReport {
  pillar: KaPillar;
  label: string;
  issuesOpened: number;
  issuesClosed: number;
  issuesStillOpen: number;
  followUpsOpened: number;
  followUpsVerified: number;
  followUpsActive: number;
}

export interface KaReportsSnapshot {
  generatedAt: string;
  from: string;
  to: string;
  kitchenId?: string;
  pillars: KaPillarReport[];
  totals: {
    issuesOpened: number;
    issuesClosed: number;
    issuesStillOpen: number;
    followUpsActive: number;
    tempAlerts: number;
    pmOverdue: number;
  };
  topOpenIssues: Array<{
    id: string;
    noDokumen: string;
    title: string;
    pillar: KaPillar;
    status: string;
    severity?: string;
    tanggal: string;
  }>;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDays(raw: string | null): number {
  const n = Number(raw || 14);
  if (!Number.isFinite(n)) return 14;
  return Math.min(90, Math.max(1, Math.floor(n)));
}

export function resolveReportRange(opts: {
  days?: string | null;
  from?: string | null;
  to?: string | null;
}): { from: string; to: string; days: number } {
  const to = (opts.to || '').trim().slice(0, 10) || ymd(new Date());
  if (opts.from?.trim()) {
    const from = opts.from.trim().slice(0, 10);
    return { from, to, days: Math.max(1, Math.ceil((Date.parse(to) - Date.parse(from)) / 86400000) + 1) };
  }
  const days = parseDays(opts.days ?? null);
  const toDate = new Date(to + 'T00:00:00Z');
  const fromDate = new Date(toDate);
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
  return { from: ymd(fromDate), to, days };
}

function emptyPillars(): KaPillarReport[] {
  return KA_PILLARS.map((pillar) => ({
    pillar,
    label: KA_PILLAR_LABELS[pillar],
    issuesOpened: 0,
    issuesClosed: 0,
    issuesStillOpen: 0,
    followUpsOpened: 0,
    followUpsVerified: 0,
    followUpsActive: 0,
  }));
}

export async function buildKaReports(
  db: Db,
  scope: { tenantId: string; kitchenId?: string; from: string; to: string },
): Promise<KaReportsSnapshot> {
  const { tenantId, kitchenId, from, to } = scope;
  const base: Record<string, unknown> = { tenantId };
  if (kitchenId) base.kitchenId = kitchenId;

  const assetIds = kitchenId ? await assetIdsForKitchen(db, tenantId, kitchenId) : null;
  const pmFilter: Record<string, unknown> = {
    tenantId,
    status: 'ACTIVE',
    nextDueDate: { $lte: to },
  };
  if (assetIds) {
    if (!assetIds.length) pmFilter.assetId = { $in: ['__none__'] };
    else pmFilter.assetId = { $in: assetIds };
  }

  const [casesOpened, casesClosed, openCases, fusInPeriod, activeFus, tempAlerts, pmRows] = await Promise.all([
    db.collection(KA_SAFETY_CASES_COLLECTION)
      .find({ ...base, tanggal: { $gte: from, $lte: to } })
      .project({ id: 1, category: 1, tanggal: 1 })
      .limit(2000)
      .toArray(),
    // Align with Analytics: closed counted by updatedAt in range
    db.collection(KA_SAFETY_CASES_COLLECTION)
      .find({
        ...base,
        status: 'CLOSED',
        updatedAt: {
          $gte: new Date(from + 'T00:00:00.000Z'),
          $lte: new Date(to + 'T23:59:59.999Z'),
        },
      })
      .project({ category: 1 })
      .limit(2000)
      .toArray(),
    db.collection(KA_SAFETY_CASES_COLLECTION)
      .find({
        ...base,
        status: { $in: ['OPEN', 'IN_PROGRESS', 'PENDING_VERIFY'] },
      })
      .project({
        id: 1,
        noDokumen: 1,
        title: 1,
        category: 1,
        status: 1,
        severity: 1,
        tanggal: 1,
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray(),
    db.collection(KA_FOLLOW_UPS_COLLECTION)
      .find({
        tenantId,
        ...(kitchenId ? { kitchenId } : {}),
        createdAt: {
          $gte: new Date(from + 'T00:00:00.000Z'),
          $lte: new Date(to + 'T23:59:59.999Z'),
        },
      })
      .project({ category: 1, status: 1 })
      .limit(2000)
      .toArray(),
    db.collection(KA_FOLLOW_UPS_COLLECTION)
      .find({
        tenantId,
        ...(kitchenId ? { kitchenId } : {}),
        status: { $in: ['OPEN', 'DONE'] },
      })
      .project({ category: 1, status: 1 })
      .limit(500)
      .toArray(),
    db.collection(TEMPERATURE_LOGS_COLLECTION).countDocuments({
      tenantId,
      ...(kitchenId ? { kitchenId } : {}),
      tanggal: { $gte: from, $lte: to },
      alertStatus: { $in: ['WARN', 'OUT_OF_RANGE', 'CRITICAL'] },
    }),
    db.collection(MAINTENANCE_SCHEDULES_COLLECTION)
      .find(pmFilter)
      .project({ id: 1 })
      .limit(200)
      .toArray(),
  ]);

  const pillars = emptyPillars();
  const byPillar = Object.fromEntries(pillars.map((p) => [p.pillar, p])) as Record<KaPillar, KaPillarReport>;

  for (const row of casesOpened) {
    const r = row as Record<string, unknown>;
    byPillar[toPillar(String(r.category))].issuesOpened += 1;
  }
  for (const row of casesClosed) {
    const r = row as Record<string, unknown>;
    byPillar[toPillar(String(r.category))].issuesClosed += 1;
  }
  for (const row of openCases) {
    const r = row as Record<string, unknown>;
    byPillar[toPillar(String(r.category))].issuesStillOpen += 1;
  }
  for (const row of fusInPeriod) {
    const r = row as Record<string, unknown>;
    const p = byPillar[toPillar(String(r.category))];
    p.followUpsOpened += 1;
    if (r.status === 'VERIFIED') p.followUpsVerified += 1;
  }
  for (const row of activeFus) {
    const r = row as Record<string, unknown>;
    byPillar[toPillar(String(r.category))].followUpsActive += 1;
  }

  const topOpenIssues = openCases.slice(0, 12).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      noDokumen: String(r.noDokumen || ''),
      title: String(r.title || ''),
      pillar: toPillar(String(r.category)),
      status: String(r.status || ''),
      severity: r.severity ? String(r.severity) : undefined,
      tanggal: String(r.tanggal || '').slice(0, 10),
    };
  });

  const totals = {
    issuesOpened: pillars.reduce((s, p) => s + p.issuesOpened, 0),
    issuesClosed: pillars.reduce((s, p) => s + p.issuesClosed, 0),
    issuesStillOpen: pillars.reduce((s, p) => s + p.issuesStillOpen, 0),
    followUpsActive: pillars.reduce((s, p) => s + p.followUpsActive, 0),
    tempAlerts: tempAlerts,
    pmOverdue: pmRows.length,
  };

  return {
    generatedAt: new Date().toISOString(),
    from,
    to,
    kitchenId,
    pillars,
    totals,
    topOpenIssues,
  };
}
