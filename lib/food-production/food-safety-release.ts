/**
 * ADR-004 P0H — HOLD → RELEASED setelah follow-up KA berstatus VERIFIED.
 * Pelepasan tidak bisa hanya dari ubah status batch; wajib corrective action + verify.
 */

import type { Db } from 'mongodb';
import {
  PRODUCTION_BATCHES_COLLECTION,
  applyFoodSafetyTransition,
  effectiveFoodSafetyStatus,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import type { KaFollowUpDoc } from '@/lib/kitchen-assurance/follow-up';
import type { KaSafetyCaseDoc } from '@/lib/kitchen-assurance/safety-case';
import { writeAuditLog } from '@/lib/api/audit-log';

export type FoodSafetyReleaseActor = {
  userId?: string;
  userName?: string;
};

export type ReleaseBatchFromFollowUpInput = {
  tenantId: string;
  followUp: Pick<KaFollowUpDoc, 'id' | 'noDokumen' | 'status' | 'safetyCaseId'>;
  safetyCase?: Pick<KaSafetyCaseDoc, 'id' | 'batchId' | 'noDokumen' | 'proposedHoldBatchIds'> | null;
  /** Alasan audit — default dari nomor FU bila kosong. */
  reason?: string;
  actor?: FoodSafetyReleaseActor;
};

export type ReleaseBatchFromFollowUpResult = {
  released: boolean;
  skipped?: string;
  batchId?: string;
  foodSafetyStatus?: string;
  error?: string;
};

/**
 * Lepas batch yang tertahan bila FU sudah VERIFIED dan case punya batchId deterministik.
 * Usulan (proposedHoldBatchIds tanpa auto-HOLD) tidak dilepas di sini.
 */
export async function releaseBatchFromVerifiedFollowUp(
  db: Db,
  input: ReleaseBatchFromFollowUpInput,
): Promise<ReleaseBatchFromFollowUpResult> {
  if (input.followUp.status !== 'VERIFIED') {
    return { released: false, skipped: 'follow_up_not_verified' };
  }

  const batchId = String(input.safetyCase?.batchId || '').trim();
  if (!batchId) {
    return { released: false, skipped: 'no_batch' };
  }

  const batch = await db.collection(PRODUCTION_BATCHES_COLLECTION).findOne({
    tenantId: input.tenantId,
    id: batchId,
  }) as ProductionBatchDoc | null;
  if (!batch) {
    return { released: false, skipped: 'batch_missing', batchId, error: 'Batch tidak ditemukan untuk pelepasan' };
  }

  const current = effectiveFoodSafetyStatus(batch);
  if (current !== 'HOLD') {
    return {
      released: false,
      skipped: current === 'RELEASED' ? 'already_released' : 'not_hold',
      batchId,
      foodSafetyStatus: current,
    };
  }

  const actor = input.actor || {};
  const now = new Date();
  const reason = String(input.reason || '').trim()
    || `Follow-up diverifikasi · ${input.followUp.noDokumen || input.followUp.id}`;

  const transitioned = applyFoodSafetyTransition(batch, {
    to: 'RELEASED',
    sourceType: 'KA_FOLLOW_UP',
    sourceId: input.followUp.id,
    reason,
    at: now,
    userId: actor.userId,
    userName: actor.userName,
  });
  if ('error' in transitioned) {
    return {
      released: false,
      batchId,
      foodSafetyStatus: current,
      error: transitioned.error,
    };
  }

  await db.collection(PRODUCTION_BATCHES_COLLECTION).updateOne(
    { tenantId: input.tenantId, id: batchId },
    {
      $set: {
        foodSafetyStatus: transitioned.foodSafetyStatus,
        foodSafetyHistory: transitioned.foodSafetyHistory,
        updatedAt: now,
      },
    },
  );

  await writeAuditLog(db, {
    tenantId: input.tenantId,
    action: 'FOOD_SAFETY_RELEASE',
    entityType: 'production_batch',
    entityId: batchId,
    summary: `Batch ${batch.batchNo || batchId} → RELEASED dari FU ${input.followUp.noDokumen || input.followUp.id}`,
    metadata: {
      sourceType: 'KA_FOLLOW_UP',
      sourceId: input.followUp.id,
      safetyCaseId: input.safetyCase?.id,
    },
    userId: actor.userId,
    userName: actor.userName,
  });

  return {
    released: true,
    batchId,
    foodSafetyStatus: transitioned.foodSafetyStatus,
  };
}
