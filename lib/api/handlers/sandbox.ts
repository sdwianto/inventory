import type { NextResponse } from 'next/server';
import { ok, err, getMongoClient } from '@/lib/api/db';
import { requireMaster } from '@/lib/api/require-auth';
import {
  getSandboxResetBlockReason,
  getSalesDbName,
  isSandboxResetUiEnabled,
  SANDBOX_CONFIRM_PHRASE,
} from '@/lib/api/sandbox-config';
import {
  executeSandboxPurge,
  previewSandboxPurge,
  SANDBOX_KEEP_HINT,
  summarizeSandboxCounts,
} from '@/lib/api/sandbox-purge';
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

    const client = await getMongoClient();
    const result = await executeSandboxPurge(db, client, { tenantId, includeSales });
    return ok({
      ok: true,
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

  return null;
}
