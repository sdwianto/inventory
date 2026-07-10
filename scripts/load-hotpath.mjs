#!/usr/bin/env node
/**
 * Smoke load test — hot path Inventory (M3.1).
 *
 *   BASE_URL=https://penarukan2.vercel.app \
 *   SESSION_COOKIE="next-auth.session-token=..." \
 *   TENANT_ID=sppg \
 *   ITERATIONS=50 \
 *   node scripts/load-hotpath.mjs
 */

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const ITERATIONS = Math.max(1, Number(process.env.ITERATIONS || 20));
const COOKIE = process.env.SESSION_COOKIE || '';
const TENANT_ID = process.env.TENANT_ID || '';

const HOTPATHS = [
  { name: 'health', path: '/api/health', thresholdMs: 500, auth: false },
  { name: 'dashboard', path: '/api/dashboard?refresh=1', thresholdMs: 2000, auth: true },
  { name: 'stok-saldo', path: '/api/inventory/stok-saldo', thresholdMs: 2000, auth: true },
  { name: 'pages-produk', path: '/api/pages/produk', thresholdMs: 2000, auth: true },
  { name: 'maintenance-report', path: '/api/maintenance-reports', thresholdMs: 2000, auth: true },
];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

async function probe({ name, path, thresholdMs, auth }) {
  const headers = { Accept: 'application/json' };
  if (auth && COOKIE) headers.Cookie = COOKIE;
  if (auth && TENANT_ID) headers['X-Tenant-Id'] = TENANT_ID;

  const durations = [];
  let failures = 0;

  for (let i = 0; i < ITERATIONS; i += 1) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${BASE_URL}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
      const ms = performance.now() - t0;
      durations.push(ms);
      if (!res.ok) failures += 1;
    } catch {
      failures += 1;
      durations.push(30_000);
    }
  }

  durations.sort((a, b) => a - b);
  const p50 = Math.round(percentile(durations, 50));
  const p95 = Math.round(percentile(durations, 95));
  const ok = failures === 0 && p95 <= thresholdMs;

  return { name, path, p50, p95, thresholdMs, failures, ok };
}

async function main() {
  console.log(`Load hotpath — ${BASE_URL} × ${ITERATIONS} iterasi`);
  if (!COOKIE) {
    console.warn('SESSION_COOKIE kosong — endpoint auth akan 401 (health tetap diuji).');
  }

  const results = [];
  for (const spec of HOTPATHS) {
    if (spec.auth && !COOKIE) {
      results.push({ ...spec, p50: 0, p95: 0, failures: ITERATIONS, ok: false, skipped: true });
      continue;
    }
    process.stdout.write(`  ${spec.name}... `);
    const row = await probe(spec);
    results.push(row);
    console.log(row.ok ? `p95=${row.p95}ms OK` : `p95=${row.p95}ms FAIL (thr ${row.thresholdMs}ms, err ${row.failures})`);
  }

  console.log('\n| Endpoint | p50 | p95 | threshold | status |');
  console.log('|----------|-----|-----|-----------|--------|');
  for (const r of results) {
    const status = r.skipped ? 'SKIP (no auth)' : (r.ok ? 'PASS' : 'FAIL');
    console.log(`| ${r.name} | ${r.p50}ms | ${r.p95}ms | ${r.thresholdMs}ms | ${status} |`);
  }

  const allOk = results.every((r) => r.skipped || r.ok);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
