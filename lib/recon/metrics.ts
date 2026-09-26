/** Gauge Prometheus `inventory_recon_mismatch_total{kind}` dari laporan rekonsiliasi terbaru tiap tenant. */

import type { Db } from 'mongodb';
import { Gauge } from 'prom-client';
import { executionMetricRegistry } from '@sdwianto/metrics';
import { latestReconReports } from '@/lib/recon/reports';
import { ALL_RECON_KINDS, RECON_JOBS } from '@/lib/recon/types';

const MISMATCH_NAME = 'inventory_recon_mismatch_total';
const AGE_NAME = 'inventory_recon_last_run_age_seconds';
const ERROR_NAME = 'inventory_recon_errors';

function gauge(name: string, help: string, labelNames: string[]): Gauge<string> {
  const existing = executionMetricRegistry.getSingleMetric(name);
  if (existing) return existing as Gauge<string>;
  return new Gauge({ name, help, labelNames, registers: [executionMetricRegistry] });
}

export async function refreshReconGauges(db: Db): Promise<void> {
  const mismatch = gauge(MISMATCH_NAME, 'Jumlah anomali rekonsiliasi per kind (Σ laporan terbaru tiap tenant)', ['kind']);
  const age = gauge(AGE_NAME, 'Umur laporan rekonsiliasi tertua per job (detik)', ['job']);
  const errors = gauge(ERROR_NAME, 'Laporan rekonsiliasi terbaru berstatus ERROR per job', ['job']);

  const reports = await latestReconReports(db);
  const totals = new Map<string, number>(ALL_RECON_KINDS.map((k) => [k, 0]));
  const oldest = new Map<string, number>();
  const errorCount = new Map<string, number>(RECON_JOBS.map((j) => [j, 0]));
  const now = Date.now();
  for (const r of reports) {
    for (const [kind, n] of Object.entries(r.summary || {})) {
      totals.set(kind, (totals.get(kind) || 0) + (Number(n) || 0));
    }
    const ageSec = Math.max(0, Math.round((now - new Date(r.createdAt).getTime()) / 1000));
    oldest.set(r.job, Math.max(oldest.get(r.job) || 0, ageSec));
    if (r.status === 'ERROR') errorCount.set(r.job, (errorCount.get(r.job) || 0) + 1);
  }
  for (const [kind, n] of totals) mismatch.labels(kind).set(n);
  for (const job of RECON_JOBS) {
    if (oldest.has(job)) age.labels(job).set(oldest.get(job)!);
    errors.labels(job).set(errorCount.get(job) || 0);
  }
}
