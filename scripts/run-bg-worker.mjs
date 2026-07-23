#!/usr/bin/env node
/**
 * Poll POST /api/bg-jobs/process — worker terpisah dari Next.js app.
 *
 * Env:
 *   WORKER_INTERNAL_URL — default http://127.0.0.1:3001
 *   WORKER_SECRET — harus sama dengan env app (opsional di dev)
 *   BG_WORKER_INTERVAL_MS — default 30000
 */

const baseUrl = (process.env.WORKER_INTERNAL_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const intervalMs = parseInt(process.env.BG_WORKER_INTERVAL_MS || '30000', 10);
const workerSecret = process.env.WORKER_SECRET || '';

async function tick() {
  const headers = { 'Content-Type': 'application/json' };
  if (workerSecret) headers['X-Worker-Secret'] = workerSecret;
  try {
    const res = await fetch(`${baseUrl}/api/bg-jobs/process`, { method: 'POST', headers });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.processed > 0) {
      console.log(`[bg-worker] processed ${data.processed} job(s)`);
    } else if (res.ok && data.recovery) {
      const r = data.recovery;
      const n =
        (r.legacyNormalized || 0) +
        (r.visibilityRequeued || 0) +
        (r.claimTimeoutRequeued || 0) +
        (r.staleRequeued || 0) +
        (r.orphanDispatchedRequeued || 0);
      if (n > 0) console.log(`[bg-worker] recovery patched/requeued ${n}`);
    } else if (!res.ok) {
      console.warn(`[bg-worker] HTTP ${res.status}`, data.error || data.message || '');
    }
  } catch (e) {
    console.warn('[bg-worker] error:', e instanceof Error ? e.message : e);
  }
}

console.log(`[bg-worker] polling ${baseUrl}/api/bg-jobs/process every ${intervalMs}ms`);
void tick();
setInterval(tick, intervalMs);
