import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  RECON_FINDINGS_CAP,
  RECON_JOBS,
  RECON_KINDS,
  type ReconDetectResult,
  type ReconJob,
  type ReconKind,
  type ReconReport,
} from '@/lib/recon/types';

export const RECON_REPORTS_COLLECTION = 'recon_reports';
export const RECON_REPORT_TTL_DAYS = 90;

let indexesReady: Promise<void> | null = null;

export function ensureReconReportIndexes(db: Db): Promise<void> {
  if (!indexesReady) {
    const col = db.collection(RECON_REPORTS_COLLECTION);
    indexesReady = Promise.all([
      col.createIndex({ tenantId: 1, job: 1, createdAt: -1 }, { name: 'tenant_job_createdAt' }),
      col.createIndex({ job: 1, createdAt: -1 }, { name: 'job_createdAt' }),
      col.createIndex(
        { createdAt: 1 },
        { name: 'ttl_createdAt', expireAfterSeconds: RECON_REPORT_TTL_DAYS * 86_400 },
      ),
    ]).then(() => undefined).catch((e) => {
      indexesReady = null;
      throw e;
    });
  }
  return indexesReady;
}

export function buildReconReport(input: {
  tenantId: string;
  job: ReconJob;
  startedAt: number;
  result?: ReconDetectResult;
  error?: string;
}): ReconReport {
  const { tenantId, job, result } = input;
  const findings = result?.findings || [];
  const summary: Partial<Record<ReconKind, number>> = {};
  for (const kind of RECON_KINDS[job]) summary[kind] = 0;
  for (const f of findings) summary[f.kind] = (summary[f.kind] || 0) + 1;
  for (const [kind, n] of Object.entries(result?.counts || {})) {
    const k = kind as ReconKind;
    summary[k] = Math.max(summary[k] || 0, Number(n) || 0);
  }
  const totalMismatch = Object.values(summary).reduce((s, n) => s + (Number(n) || 0), 0);
  const status = input.error ? 'ERROR' : result?.skippedReason ? 'SKIPPED' : 'OK';
  return {
    id: uuidv4(),
    tenantId,
    job,
    status,
    createdAt: new Date(),
    durationMs: Date.now() - input.startedAt,
    summary,
    totalMismatch,
    findings: findings.slice(0, RECON_FINDINGS_CAP),
    truncated: totalMismatch > Math.min(findings.length, RECON_FINDINGS_CAP),
    ...(result?.skippedReason ? { skippedReason: result.skippedReason } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(result?.meta ? { meta: result.meta } : {}),
  };
}

export async function saveReconReport(db: Db, report: ReconReport): Promise<void> {
  await ensureReconReportIndexes(db);
  await db.collection(RECON_REPORTS_COLLECTION).insertOne({ ...report });
}

export type ReconReportSummary = Omit<ReconReport, 'findings'> & { findingCount: number };

/** Laporan terbaru per (tenant, job). `tenantId` kosong = semua tenant. */
export async function latestReconReports(
  db: Db,
  opts: { tenantId?: string; jobs?: ReconJob[] } = {},
): Promise<ReconReportSummary[]> {
  await ensureReconReportIndexes(db);
  const jobs = opts.jobs?.length ? opts.jobs : [...RECON_JOBS];
  const match: Record<string, unknown> = { job: { $in: jobs } };
  if (opts.tenantId) match.tenantId = opts.tenantId;
  const rows = await db.collection(RECON_REPORTS_COLLECTION).aggregate<ReconReportSummary>([
    { $match: match },
    { $sort: { createdAt: -1 } },
    { $group: { _id: { tenantId: '$tenantId', job: '$job' }, doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $addFields: { findingCount: { $size: { $ifNull: ['$findings', []] } } } },
    { $project: { _id: 0, findings: 0 } },
    { $sort: { tenantId: 1, job: 1 } },
  ]).toArray();
  return rows;
}

export async function getReconReport(db: Db, id: string): Promise<ReconReport | null> {
  return db.collection(RECON_REPORTS_COLLECTION).findOne(
    { id },
    { projection: { _id: 0 } },
  ) as Promise<ReconReport | null>;
}
