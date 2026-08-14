import { after } from 'next/server';
import type { NextResponse } from 'next/server';
import { ok, err, getMongoClient, connectToMongo } from '@/lib/api/db';
import { requireMaster } from '@/lib/api/require-auth';
import { verifyWorkerOrCronSecret } from '@/lib/api/worker-auth';
import {
  getSandboxResetBlockReason,
  getSalesDbName,
  getWorkerSandboxBlockReason,
  isSandboxResetUiEnabled,
  SANDBOX_CONFIRM_PHRASE,
} from '@/lib/api/sandbox-config';
import {
  previewSandboxPurge,
  purgeSandboxDatabase,
  SANDBOX_KEEP_HINT,
  SANDBOX_PURGE_PROFILES,
  keepHintForSandboxProfile,
  normalizeSandboxPurgeProfile,
  salesRemotePurgeConfigured,
  sandboxResetDedupeKey,
  summarizeSandboxCounts,
} from '@/lib/api/sandbox-purge';
import { enqueueJob, processJobById, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';
import { shouldProcessJobInline } from '@/lib/api/execution-wave';
import { runSandboxResetJobById } from '@/lib/api/sandbox-reset-run';
import type { HandlerContext } from '@/types/api/handler';
import { parseHandlerBody } from '@/types/api/handler';

export async function handleSandbox({
  db,
  route,
  method,
  url,
  body,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (!route.startsWith('/sandbox')) return null;

  // Worker routes — dipanggil inventory → sales.app (SALES_APP_URL + WORKER_SECRET).
  if (route === '/sandbox/worker-preview' && method === 'GET') {
    if (!verifyWorkerOrCronSecret(request)) return err('Unauthorized', 401);
    const workerBlock = getWorkerSandboxBlockReason();
    if (workerBlock) return err(workerBlock, 403);
    const tenantId = url.searchParams.get('tenantId')?.trim() || undefined;
    const result = await purgeSandboxDatabase(db, 'sales', db.databaseName, tenantId, false);
    return ok({
      ...result,
      summary: summarizeSandboxCounts(result),
    });
  }

  if (route === '/sandbox/worker-purge' && method === 'POST') {
    if (!verifyWorkerOrCronSecret(request)) return err('Unauthorized', 401);
    const workerBlock = getWorkerSandboxBlockReason();
    if (workerBlock) return err(workerBlock, 403);
    const payload = parseHandlerBody(body);
    const tenantId = String(payload.tenantId || '').trim() || undefined;
    const result = await purgeSandboxDatabase(db, 'sales', db.databaseName, tenantId, true);
    return ok({
      ...result,
      summary: summarizeSandboxCounts(result),
    });
  }

  if (route === '/sandbox/status' && method === 'GET') {
    const denied = requireMaster(auth);
    if (denied) return denied;
    const blockReason = getSandboxResetBlockReason();
    let salesWorkerReady: boolean | null = null;
    if (salesRemotePurgeConfigured()) {
      try {
        const base = String(process.env.SALES_APP_URL || '').replace(/\/$/, '');
        const secret = (process.env.WORKER_SECRET || '').trim();
        const res = await fetch(`${base}/api/sandbox/worker-preview`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(8_000),
        });
        salesWorkerReady = res.ok;
      } catch {
        salesWorkerReady = false;
      }
    }
    return ok({
      enabled: isSandboxResetUiEnabled() && !blockReason,
      blockReason,
      confirmPhrase: SANDBOX_CONFIRM_PHRASE,
      inventoryDbName: db.databaseName,
      salesDbName: getSalesDbName(),
      salesPurgeVia: salesRemotePurgeConfigured() ? 'SALES_APP_URL' : 'MONGO_URL',
      salesWorkerReady,
      keepHint: SANDBOX_KEEP_HINT,
      profiles: SANDBOX_PURGE_PROFILES.map((id) => ({
        id,
        label: id === 'kitchen-assurance' ? 'Kitchen Assurance saja' : 'Reset penuh',
        keepHint: keepHintForSandboxProfile(id),
        allowIncludeSales: id === 'full',
      })),
    });
  }

  const blockReason = getSandboxResetBlockReason();
  if (blockReason) return err(blockReason, 403);

  const denied = requireMaster(auth);
  if (denied) return denied;

  if (route === '/sandbox/preview' && method === 'GET') {
    const tenantId = url.searchParams.get('tenantId')?.trim() || undefined;
    const profile = normalizeSandboxPurgeProfile(url.searchParams.get('profile'));
    const includeSales = profile === 'kitchen-assurance'
      ? false
      : url.searchParams.get('includeSales') !== '0';
    const client = await getMongoClient();
    const result = await previewSandboxPurge(db, client, { tenantId, includeSales, profile });
    return ok({
      tenantId: tenantId || null,
      scope: tenantId ? 'tenant' : 'all',
      profile,
      includeSales,
      salesPurgeVia: salesRemotePurgeConfigured() ? 'SALES_APP_URL' : 'MONGO_URL',
      inventory: {
        ...result.inventory,
        summary: summarizeSandboxCounts(result.inventory),
      },
      sales: result.sales
        ? { ...result.sales, summary: summarizeSandboxCounts(result.sales) }
        : null,
    });
  }

  if (route === '/sandbox/reset' && method === 'POST') {
    const payload = parseHandlerBody(body);
    const confirmPhrase = String(payload.confirmPhrase || '').trim();
    if (confirmPhrase !== SANDBOX_CONFIRM_PHRASE) {
      return err(`Ketik frasa konfirmasi persis: ${SANDBOX_CONFIRM_PHRASE}`, 400);
    }

    const tenantId = String(payload.tenantId || '').trim() || undefined;
    const profile = normalizeSandboxPurgeProfile(payload.profile);
    const includeSales = profile === 'kitchen-assurance'
      ? false
      : payload.includeSales !== false;

    const dedupeKey = sandboxResetDedupeKey({ profile, tenantId, includeSales });
    const { jobId, reused } = await enqueueJob(db, {
      type: JOB_TYPES.SANDBOX_RESET,
      tenantId: tenantId || 'system',
      payload: { tenantId, includeSales, profile, dedupeKey },
    });

    // Pastikan domain inventory (worker claim) — perbaikan job stale domain=maintenance.
    await db.collection('bg_jobs').updateOne(
      { id: jobId, status: { $in: ['PENDING', 'RUNNING'] } },
      { $set: { domain: 'inventory', updatedAt: new Date() } },
    );

    // VPS EE-10: jangan andalkan legacy poll. Jalankan di after() + worker race-safe.
    after(async () => {
      const freshDb = await connectToMongo();
      if (shouldProcessJobInline(JOB_TYPES.SANDBOX_RESET)) {
        await processJobById(freshDb, jobId);
        return;
      }
      await runSandboxResetJobById(freshDb, jobId);
    });
    scheduleJobProcessing(db, { limit: 1 });

    return ok({
      jobId,
      async: true,
      status: reused ? 'RUNNING' : 'PENDING',
      reused,
      profile,
      message: profile === 'kitchen-assurance'
        ? 'Reset Kitchen Assurance berjalan di background'
        : 'Reset sandbox berjalan di background',
    }, 202);
  }

  return null;
}
