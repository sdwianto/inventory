/** Jalankan SANDBOX_RESET segera — fallback jika execution worker belum claim. */

import type { Db } from 'mongodb';
import { executeSandboxResetJob } from '@/lib/api/inventory-execution-handlers';

/**
 * Klaim atomik job PENDING lalu jalankan purge.
 * Aman dipanggil paralel dengan inventory-worker (salah satu menang claim).
 */
export async function runSandboxResetJobById(
  db: Db,
  jobId: string,
): Promise<{ skipped?: boolean; reason?: string; ok?: boolean; error?: string }> {
  const now = new Date();
  const claimed = await db.collection('bg_jobs').findOneAndUpdate(
    { id: jobId, status: 'PENDING' },
    {
      $set: {
        status: 'RUNNING',
        domain: 'inventory',
        startedAt: now,
        updatedAt: now,
        heartbeatAt: now,
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' },
  );

  if (!claimed) {
    const existing = await db.collection('bg_jobs').findOne({ id: jobId });
    return {
      skipped: true,
      reason: existing
        ? `status=${String(existing.status || '')}`
        : 'job tidak ditemukan',
    };
  }

  const payload = (claimed.payload && typeof claimed.payload === 'object')
    ? claimed.payload as Record<string, unknown>
    : {};

  let outcome: Record<string, unknown>;
  try {
    outcome = await executeSandboxResetJob(db, payload, jobId);
  } catch (e) {
    outcome = { error: e instanceof Error ? e.message : String(e) };
  }

  const failed = Boolean(outcome.error);
  const done = new Date();
  await db.collection('bg_jobs').updateOne(
    { id: jobId },
    {
      $set: {
        status: failed ? 'FAILED' : 'DONE',
        lastError: failed ? String(outcome.error) : null,
        result: outcome,
        finishedAt: done,
        updatedAt: done,
        visibilityTimeoutAt: null,
        workerId: failed ? claimed.workerId : null,
      },
    },
  );

  if (failed) return { error: String(outcome.error) };
  return { ok: true };
}
