import type { Db } from 'mongodb';
import { logger } from '@/lib/api/logger';
import { detectStockRecon } from '@/lib/recon/stock-recon';
import { detectPoReceiptRecon } from '@/lib/recon/po-receipt-recon';
import { detectGrniRecon } from '@/lib/recon/grni-recon';
import { detectPlanIssueRecon } from '@/lib/recon/plan-issue-recon';
import { detectControlsRecon } from '@/lib/recon/controls-recon';
import { listReconTenantIds } from '@/lib/recon/context';
import { buildReconReport, saveReconReport } from '@/lib/recon/reports';
import { RECON_JOBS, type ReconDetectResult, type ReconJob, type ReconReport } from '@/lib/recon/types';

type Detector = (db: Db, tenantId: string, opts: { now?: Date }) => Promise<ReconDetectResult>;

const DETECTORS: Record<ReconJob, Detector> = {
  stock: detectStockRecon,
  'po-receipt': detectPoReceiptRecon,
  grni: detectGrniRecon,
  'plan-issue': detectPlanIssueRecon,
  controls: detectControlsRecon,
};

export function parseReconJobs(value: unknown): ReconJob[] | null {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'all') return [...RECON_JOBS];
  const jobs = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!jobs.every((j) => (RECON_JOBS as readonly string[]).includes(j))) return null;
  return [...new Set(jobs)] as ReconJob[];
}

export async function runReconForTenant(
  db: Db,
  tenantId: string,
  job: ReconJob,
  opts: { now?: Date } = {},
): Promise<ReconReport> {
  const startedAt = Date.now();
  let report: ReconReport;
  try {
    const result = await DETECTORS[job](db, tenantId, opts);
    report = buildReconReport({ tenantId, job, startedAt, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('recon_detect_failed', { tenantId, job, error: message });
    report = buildReconReport({ tenantId, job, startedAt, error: message });
  }
  await saveReconReport(db, report);
  if (report.totalMismatch > 0) {
    logger.warn('recon_mismatch', { tenantId, job, totalMismatch: report.totalMismatch, summary: report.summary });
  }
  return report;
}

export type ReconRunResult = {
  jobs: ReconJob[];
  tenants: number;
  reports: number;
  totalMismatch: number;
  errors: number;
  results: Array<Pick<ReconReport, 'id' | 'tenantId' | 'job' | 'status' | 'totalMismatch'>>;
};

/** Jalankan job untuk satu tenant atau semua tenant, berurutan agar beban DB rata. */
export async function runRecon(
  db: Db,
  input: { jobs: ReconJob[]; tenantId?: string; allTenants?: boolean; now?: Date },
): Promise<ReconRunResult> {
  const tenantIds = input.allTenants || !input.tenantId
    ? await listReconTenantIds(db)
    : [input.tenantId];
  const results: ReconRunResult['results'] = [];
  let totalMismatch = 0;
  let errors = 0;
  for (const tenantId of tenantIds) {
    for (const job of input.jobs) {
      const r = await runReconForTenant(db, tenantId, job, { now: input.now });
      totalMismatch += r.totalMismatch;
      if (r.status === 'ERROR') errors += 1;
      results.push({ id: r.id, tenantId: r.tenantId, job: r.job, status: r.status, totalMismatch: r.totalMismatch });
    }
  }
  return {
    jobs: input.jobs,
    tenants: tenantIds.length,
    reports: results.length,
    totalMismatch,
    errors,
    results: results.slice(0, 200),
  };
}

/** Payload bg job INVENTORY_RECON: `{ job: ReconJob | 'a,b' | 'all', allTenants?, tenantId? }`. */
export async function runReconJobPayload(
  db: Db,
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const jobs = parseReconJobs(payload.job);
  if (!jobs) return { error: `Job rekonsiliasi tidak dikenal: ${String(payload.job)}` };
  const target = String(payload.tenantId || '').trim()
    || (tenantId && tenantId !== 'system' ? tenantId : '');
  const result = await runRecon(db, {
    jobs,
    allTenants: payload.allTenants === true || !target,
    tenantId: target || undefined,
  });
  return { ...result };
}
