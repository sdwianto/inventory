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
    createdAt: now,
  });
  return id;
}

export async function finishIntegrationCommand(
  db: Db,
  id: string,
  patch: {
    status: Exclude<CommandLogStatus, 'STARTED'>;
    invoiceId?: string | null;
    apId?: string | null;
    errorCode?: string | null;
    retryCount?: number;
  },
): Promise<void> {
  const now = new Date();
  const existing = await db.collection('integration_commands').findOne({ id });
  const startedAt = existing?.startedAt ? new Date(existing.startedAt as Date) : now;
  const durationMs = Math.max(0, now.getTime() - startedAt.getTime());
  await db.collection('integration_commands').updateOne(
    { id },
    {
      $set: {
        status: patch.status,
        finishedAt: now,
        durationMs,
        invoiceId: patch.invoiceId ?? existing?.invoiceId ?? null,
        apId: patch.apId ?? existing?.apId ?? null,
        errorCode: patch.errorCode ?? null,
        retryCount: patch.retryCount ?? existing?.retryCount ?? 0,
      },
    },
  );
}
