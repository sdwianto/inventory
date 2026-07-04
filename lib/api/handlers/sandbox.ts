import { after } from 'next/server';
import type { NextResponse } from 'next/server';
import { ok, err, getMongoClient, connectToMongo } from '@/lib/api/db';
import { requireMaster } from '@/lib/api/require-auth';
import {
  getSandboxResetBlockReason,
  getSalesDbName,
  isSandboxResetUiEnabled,
  SANDBOX_CONFIRM_PHRASE,
} from '@/lib/api/sandbox-config';
import {
  previewSandboxPurge,
  SANDBOX_KEEP_HINT,
  summarizeSandboxCounts,
} from '@/lib/api/sandbox-purge';
import { enqueueJob, processJobById, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';
import type { HandlerContext } from '@/types/api/handler';
import { parseHandlerBody } from '@/types/api/handler';

export async function handleSandbox({
  db,
  route,
  method,
  url,
  body,
  auth,
}: HandlerContext): Promise<NextResponse | null> {
  if (!route.startsWith('/sandbox')) return null;

  if (route === '/sandbox/status' && method === 'GET') {
    const denied = requireMaster(auth);
    if (denied) return denied;
    const blockReason = getSandboxResetBlockReason();
    return ok({
      enabled: isSandboxResetUiEnabled() && !blockReason,
      blockReason,
      confirmPhrase: SANDBOX_CONFIRM_PHRASE,
      inventoryDbName: db.databaseName,
      salesDbName: getSalesDbName(),
      keepHint: SANDBOX_KEEP_HINT,
    });
  }

  const blockReason = getSandboxResetBlockReason();
  if (blockReason) return err(blockReason, 403);

  const denied = requireMaster(auth);
  if (denied) return denied;

  if (route === '/sandbox/preview' && method === 'GET') {
    const tenantId = url.searchParams.get('tenantId')?.trim() || undefined;
    const includeSales = url.searchParams.get('includeSales') !== '0';
    const client = await getMongoClient();
    const result = await previewSandboxPurge(db, client, { tenantId, includeSales });
    return ok({
      tenantId: tenantId || null,
      scope: tenantId ? 'tenant' : 'all',
      includeSales,
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
    const includeSales = payload.includeSales !== false;

    const { jobId, reused } = await enqueueJob(db, {
      type: JOB_TYPES.SANDBOX_RESET,
      tenantId: tenantId || 'system',
      payload: { tenantId, includeSales },
    });

    // Vercel: purge bisa >60s — jangan blokir response HTTP (hindari 504).
    after(async () => {
      const freshDb = await connectToMongo();
      await processJobById(freshDb, jobId);
    });
    scheduleJobProcessing(db, { limit: 1 });

    return ok({
      jobId,
      async: true,
      status: reused ? 'RUNNING' : 'PENDING',
      reused,
      message: 'Reset sandbox berjalan di background',
    }, 202);
  }

  return null;
}
