import { describe, expect, it, beforeEach } from 'vitest';
import {
  resolveFpMetric,
  isFpRoute,
  recordRequestDuration,
  recordFpFailure,
  getFpRecentFailures,
  getFpLatencySnapshots,
  getFpHotpathSlo,
  __resetFpMetricsForTests,
} from '@/lib/api/request-metrics';

describe('request-metrics FP observability sprint 22', () => {
  beforeEach(() => {
    __resetFpMetricsForTests();
  });

  it('maps FP routes to metric buckets', () => {
    expect(resolveFpMetric('/material-issues')).toBe('fp_issue');
    expect(resolveFpMetric('/material-issues/abc/status')).toBe('fp_issue');
    expect(resolveFpMetric('/haccp-results')).toBe('fp_haccp');
    expect(resolveFpMetric('/temperature-logs/alerts')).toBe('fp_cold_chain');
    expect(resolveFpMetric('/fp-public/plans')).toBe('fp_public');
    expect(resolveFpMetric('/products')).toBeNull();
    expect(isFpRoute('/production-results')).toBe(true);
    expect(isFpRoute('/stok/saldo')).toBe(false);
  });

  it('records latency samples and failures', async () => {
    await recordRequestDuration('POST', '/material-issues', 120, 200);
    await recordRequestDuration('POST', '/material-issues', 2500, 200);
    await recordRequestDuration('POST', '/material-issues', 100, 500);
    recordFpFailure({
      method: 'POST',
      route: '/material-issues',
      status: 500,
      durationMs: 100,
      error: 'boom',
    });

    const snaps = await getFpLatencySnapshots();
    const issue = snaps.find((s) => s.metric === 'fp_issue');
    expect(issue).toBeTruthy();
    expect(issue!.sampleCount).toBe(3);
    expect(issue!.slowCount).toBeGreaterThanOrEqual(1);
    expect(issue!.count5xx).toBeGreaterThanOrEqual(1);

    const fails = getFpRecentFailures();
    expect(fails[0].error).toBe('boom');
    expect(fails[0].metric).toBe('fp_issue');

    const hot = await getFpHotpathSlo();
    expect(hot.sampleCount).toBeGreaterThan(0);
    expect(hot.thresholdMs).toBe(2000);
  });
});
