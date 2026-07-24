import type { Db } from 'mongodb';
import { randomUUID } from 'node:crypto';

export type CommandLogStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED';

export type IntegrationCommandStart = {
  correlationId: string;
  commandType: string;
  grnId?: string | null;
  invoiceId?: string | null;
  apId?: string | null;
  node?: string;
};

export type IntegrationCommandFinish = {
  status: Exclude<CommandLogStatus, 'STARTED'>;
  invoiceId?: string | null;
  apId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorClass?: string | null;
  httpStatus?: number | null;
  retryCount?: number;
};

function truncateMessage(msg: string | null | undefined, max = 2000): string | null {
  if (msg == null) return null;
  const s = String(msg);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Structured log for IntegrationClient command lifecycle (H3). */
function logCommandEvent(
  event: 'start' | 'finish',
  fields: Record<string, unknown>,
): void {
  console.info(JSON.stringify({
    scope: 'integration_client',
    event,
    ts: new Date().toISOString(),
    ...fields,
  }));
}

export async function startIntegrationCommand(
  db: Db,
  input: IntegrationCommandStart,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.collection('integration_commands').insertOne({
    id,
    correlationId: input.correlationId,
    commandType: input.commandType,
    grnId: input.grnId || null,
    invoiceId: input.invoiceId || null,
    apId: input.apId || null,
    startedAt: now,
    finishedAt: null,
    durationMs: null,
    status: 'STARTED' satisfies CommandLogStatus,
    retryCount: 0,
    node: input.node || process.env.HOSTNAME || 'inventory',
    errorCode: null,
    errorMessage: null,
    errorClass: null,
    httpStatus: null,
    createdAt: now,
  });
  logCommandEvent('start', {
    commandId: id,
    correlationId: input.correlationId,
    commandType: input.commandType,
    grnId: input.grnId || null,
    node: input.node || process.env.HOSTNAME || 'inventory',
  });
  return id;
}

export async function finishIntegrationCommand(
  db: Db,
  id: string,
  patch: IntegrationCommandFinish,
): Promise<{ durationMs: number }> {
  const now = new Date();
  const existing = await db.collection('integration_commands').findOne({ id });
  const startedAt = existing?.startedAt ? new Date(existing.startedAt as Date) : now;
  const durationMs = Math.max(0, now.getTime() - startedAt.getTime());
  const errorCode = patch.status === 'FAILED' ? (patch.errorCode ?? null) : null;
  const errorMessage = patch.status === 'FAILED'
    ? truncateMessage(patch.errorMessage)
    : null;
  const errorClass = patch.status === 'FAILED' ? (patch.errorClass ?? null) : null;
  const httpStatus = patch.status === 'FAILED'
    ? (patch.httpStatus ?? null)
    : null;

  await db.collection('integration_commands').updateOne(
    { id },
    {
      $set: {
        status: patch.status,
        finishedAt: now,
        durationMs,
        invoiceId: patch.invoiceId ?? existing?.invoiceId ?? null,
        apId: patch.apId ?? existing?.apId ?? null,
        errorCode,
        errorMessage,
        errorClass,
        httpStatus,
        retryCount: patch.retryCount ?? existing?.retryCount ?? 0,
      },
    },
  );

  logCommandEvent('finish', {
    commandId: id,
    correlationId: existing?.correlationId ?? null,
    commandType: existing?.commandType ?? null,
    status: patch.status,
    durationMs,
    errorCode,
    errorMessage,
    errorClass,
    httpStatus,
    grnId: existing?.grnId ?? null,
    invoiceId: patch.invoiceId ?? existing?.invoiceId ?? null,
  });

  return { durationMs };
}
