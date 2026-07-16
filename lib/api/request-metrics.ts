/**
 * FP request duration + failure metrics — ADR-001 Phase 5 / Sprint 22.
 * In-memory ring (+ optional Redis) for MASTER Ops dashboard.
 */

import { buildRedisKey, isRedisConfigured, redisCommand } from '@/lib/api/redis-rest';

const MAX_SAMPLES = 200;
const MAX_FAILURES = 50;
const SLOW_MS = 2000;
const FP_P95_THRESHOLD_MS = 2000;

/** Map route root → FP metric bucket. */
const FP_ROUTE_METRICS: Array<{ prefix: string; metric: string }> = [
  { prefix: '/material-issues', metric: 'fp_issue' },
  { prefix: '/production-results', metric: 'fp_result' },
  { prefix: '/production-plans', metric: 'fp_plan' },
  { prefix: '/material-requirements', metric: 'fp_mrp' },
  { prefix: '/purchase-requirements', metric: 'fp_pr' },
  { prefix: '/kitchen-transfers', metric: 'fp_transfer' },
  { prefix: '/distribution-orders', metric: 'fp_distribution' },
  { prefix: '/temperature-logs', metric: 'fp_cold_chain' },
  { prefix: '/temperature-thresholds', metric: 'fp_cold_chain' },
  { prefix: '/haccp-results', metric: 'fp_haccp' },
  { prefix: '/haccp-templates', metric: 'fp_haccp' },
  { prefix: '/production-batches', metric: 'fp_batch' },
  { prefix: '/qc-results', metric: 'fp_qc' },
  { prefix: '/qc-templates', metric: 'fp_qc' },
  { prefix: '/fp-public', metric: 'fp_public' },
  { prefix: '/kitchens', metric: 'fp_kitchen' },
  { prefix: '/service-points', metric: 'fp_service_point' },
  { prefix: '/food-dashboard', metric: 'fp_dashboard' },
  { prefix: '/food-recommendations', metric: 'fp_ai' },
  { prefix: '/food-forecasts', metric: 'fp_forecast' },
  { prefix: '/food-costs', metric: 'fp_cost' },
  { prefix: '/nutrition-profiles', metric: 'fp_nutrition' },
];

const MEMORY_SAMPLES: Map<string, number[]> = new Map();
const MEMORY_ERROR_COUNTS: Map<string, { count5xx: number; count4xx: number; slow: number }> = new Map();
const MEMORY_FAILURES: Array<FpRecentFailure> = [];

export interface FpRecentFailure {
  at: string;
  method: string;
  route: string;
  status: number;
  durationMs?: number;
  error?: string;
  tenantId?: string;
  metric?: string;
}

export interface FpLatencySnapshot {
  metric: string;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  thresholdMs: number;
  ok: boolean;
  slowCount: number;
  count5xx: number;
  count4xx: number;
}

export function resolveFpMetric(route: string): string | null {
  const r = route.startsWith('/') ? route : `/${route}`;
  for (const row of FP_ROUTE_METRICS) {
    if (r === row.prefix || r.startsWith(`${row.prefix}/`)) return row.metric;
  }
  return null;
}

export function isFpRoute(route: string): boolean {
  return resolveFpMetric(route) != null;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

async function pushSample(metric: string, durationMs: number): Promise<void> {
  const mem = MEMORY_SAMPLES.get(metric) || [];
  mem.push(durationMs);
  if (mem.length > MAX_SAMPLES) mem.shift();
  MEMORY_SAMPLES.set(metric, mem);

  if (!isRedisConfigured()) return;
  try {
    const key = buildRedisKey('fp_slo', metric);
    await redisCommand(['LPUSH', key, String(durationMs)]);
    await redisCommand(['LTRIM', key, 0, MAX_SAMPLES - 1]);
    await redisCommand(['EXPIRE', key, 86400]);
  } catch {
    /* best-effort */
  }
}

async function readSamples(metric: string): Promise<number[]> {
  if (isRedisConfigured()) {
    try {
      const key = buildRedisKey('fp_slo', metric);
      const raw = await redisCommand(['LRANGE', key, 0, MAX_SAMPLES - 1]);
      if (Array.isArray(raw) && raw.length) {
        return raw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n >= 0);
      }
    } catch {
      /* fall through */
    }
  }
  return MEMORY_SAMPLES.get(metric) || [];
}

function bumpErrors(metric: string, status: number, durationMs: number) {
  const cur = MEMORY_ERROR_COUNTS.get(metric) || { count5xx: 0, count4xx: 0, slow: 0 };
  if (status >= 500) cur.count5xx += 1;
  else if (status >= 400) cur.count4xx += 1;
  if (durationMs > SLOW_MS) cur.slow += 1;
  MEMORY_ERROR_COUNTS.set(metric, cur);
}

export async function recordRequestDuration(
  method: string,
  route: string,
  durationMs: number,
  status = 200,
): Promise<void> {
  void method;
  const metric = resolveFpMetric(route);
  if (!metric || durationMs < 0) return;
  await pushSample(metric, durationMs);
  bumpErrors(metric, status, durationMs);
}

export function recordFpFailure(input: Omit<FpRecentFailure, 'at'> & { at?: string }): void {
  const metric = input.metric || resolveFpMetric(input.route) || undefined;
  MEMORY_FAILURES.unshift({
    at: input.at || new Date().toISOString(),
    method: input.method,
    route: input.route,
    status: input.status,
    durationMs: input.durationMs,
    error: input.error,
    tenantId: input.tenantId,
    metric,
  });
  if (MEMORY_FAILURES.length > MAX_FAILURES) MEMORY_FAILURES.length = MAX_FAILURES;
}

export function getFpRecentFailures(limit = 25): FpRecentFailure[] {
  return MEMORY_FAILURES.slice(0, limit);
}

export async function getFpLatencySnapshots(): Promise<FpLatencySnapshot[]> {
  const metrics = [...new Set(FP_ROUTE_METRICS.map((r) => r.metric))];
  const out: FpLatencySnapshot[] = [];
  for (const metric of metrics) {
    const samples = await readSamples(metric);
    const sorted = [...samples].sort((a, b) => a - b);
    const errs = MEMORY_ERROR_COUNTS.get(metric) || { count5xx: 0, count4xx: 0, slow: 0 };
    const p95Ms = Math.round(percentile(sorted, 95));
    out.push({
      metric,
      sampleCount: sorted.length,
      p50Ms: Math.round(percentile(sorted, 50)),
      p95Ms,
      thresholdMs: FP_P95_THRESHOLD_MS,
      ok: sorted.length === 0 || p95Ms < FP_P95_THRESHOLD_MS,
      slowCount: errs.slow,
      count5xx: errs.count5xx,
      count4xx: errs.count4xx,
    });
  }
  return out.filter((s) => s.sampleCount > 0 || s.count5xx > 0 || s.count4xx > 0 || s.slowCount > 0);
}

export async function getFpHotpathSlo(): Promise<{
  sampleCount: number;
  p95Ms: number;
  thresholdMs: number;
  ok: boolean;
}> {
  const hot = ['fp_issue', 'fp_result', 'fp_plan', 'fp_transfer', 'fp_haccp'];
  const all: number[] = [];
  for (const m of hot) {
    all.push(...(await readSamples(m)));
  }
  const sorted = [...all].sort((a, b) => a - b);
  const p95Ms = Math.round(percentile(sorted, 95));
  return {
    sampleCount: sorted.length,
    p95Ms,
    thresholdMs: FP_P95_THRESHOLD_MS,
    ok: sorted.length === 0 || p95Ms < FP_P95_THRESHOLD_MS,
  };
}

export const FP_SLOW_REQUEST_MS = SLOW_MS;

/** Test helper — clear in-memory rings. */
export function __resetFpMetricsForTests() {
  MEMORY_SAMPLES.clear();
  MEMORY_ERROR_COUNTS.clear();
  MEMORY_FAILURES.length = 0;
}
