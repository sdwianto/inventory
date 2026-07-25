/**
 * W1-2 slice 2 orchestrator for ENSURE_PUSH_CANCEL_SO.
 * Primary drain after commit; enqueue recovery on FAILED — drain never enqueues.
 */

import type { Db } from 'mongodb';
import { drainEnsurePushCancelSo } from '@/lib/api/integration-outbox';
import { enqueueAndKickCancelSoPushRecovery } from '@/lib/api/enqueue-cancel-so-push-recovery';

export type OrchestratePushCancelSoResult = {
  ok: boolean;
  salesNotify?: { cancelled: unknown[]; errors: unknown[]; correlationId?: string };
  error?: string;
  jobId?: string;
  outboxId?: string | null;
};

export async function orchestrateEnsurePushCancelSoAfterCommit(
  db: Db,
  input: { tenantId: string; poId: string; reason?: string | null },
): Promise<OrchestratePushCancelSoResult> {
  const drained = await drainEnsurePushCancelSo(db, input);
  if (drained.ok) {
    return {
      ok: true,
      salesNotify: drained.salesNotify,
      outboxId: drained.outboxId,
    };
  }

  let jobId: string | undefined;
  try {
    const enq = await enqueueAndKickCancelSoPushRecovery(db, input.tenantId, {
      poId: input.poId,
      reason: input.reason,
    });
    jobId = enq.jobId;
  } catch {
    /* CPO already CANCELLED — recovery best-effort */
  }

  return {
    ok: false,
    salesNotify: drained.salesNotify,
    error: drained.error,
    jobId,
    outboxId: drained.outboxId,
  };
}
