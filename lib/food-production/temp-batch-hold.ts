/**
 * ADR-004 P0E — tahan production batch dari log suhu COOKING/HOLDING
 * yang OUT_OF_RANGE / CRITICAL dan terikat productionBatchId.
 */

import type { Db } from 'mongodb';
import {
  PRODUCTION_BATCHES_COLLECTION,
  applyFoodSafetyTransition,
  effectiveFoodSafetyStatus,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import {
  TEMP_STAGE_LABELS,
  buildTempHoldReason,
  shouldHoldBatchFromTemp,
  type TempAlertStatus,
  type TempStage,
} from '@/lib/food-production/temperature-log';
import { ensureOpenKaIssue } from '@/lib/kitchen-assurance/auto-issue';
import { KA_SAFETY_CASES_COLLECTION } from '@/lib/kitchen-assurance/safety-case';
import { writeAuditLog } from '@/lib/api/audit-log';

export type TempBatchHoldActor = {
  userId?: string;
  userName?: string;
};

export type ApplyTempHoldInput = {
  tenantId: string;
  productionBatchId: string;
  temperatureLogId: string;
  stage: TempStage;
  alertStatus: TempAlertStatus;
  suhuC: number;
  thresholdMinC?: number;
  thresholdMaxC?: number;
  kitchenId?: string;
  kitchenNama?: string;
  actor?: TempBatchHoldActor;
  openSafetyCase?: boolean;
};

export type ApplyTempHoldResult = {
  held: boolean;
  skipped?: string;
  foodSafetyStatus?: string;
  kaIssue?: { noDokumen?: string; created?: boolean; skipped?: string };
  error?: string;
};

/**
 * Tahan batch bila shouldHoldBatchFromTemp().
 * Idempoten bila sudah HOLD; kegagalan KA tidak membatalkan HOLD.
 */
export async function applyTempHoldToBatch(
  db: Db,
  input: ApplyTempHoldInput,
): Promise<ApplyTempHoldResult> {
  const batchId = String(input.productionBatchId || '').trim();
  if (!shouldHoldBatchFromTemp({
    stage: input.stage,
    alertStatus: input.alertStatus,
    productionBatchId: batchId,
  })) {
    return { held: false, skipped: batchId ? 'no_candidate' : 'no_batch' };
  }

  const batch = await db.collection(PRODUCTION_BATCHES_COLLECTION).findOne({
    tenantId: input.tenantId,
    id: batchId,
  }) as ProductionBatchDoc | null;
  if (!batch) {
    return { held: false, skipped: 'batch_missing', error: 'Batch tidak ditemukan untuk penahanan' };
  }

  const actor = input.actor || {};
  const now = new Date();
  let held = false;
  let foodSafetyStatus = effectiveFoodSafetyStatus(batch);
  const reason = buildTempHoldReason({
    stage: input.stage,
    alertStatus: input.alertStatus,
    suhuC: input.suhuC,
    minC: input.thresholdMinC,
    maxC: input.thresholdMaxC,
    batchNo: batch.batchNo,
  });

  if (foodSafetyStatus !== 'HOLD') {
    const transitioned = applyFoodSafetyTransition(batch, {
      to: 'HOLD',
      sourceType: 'TEMPERATURE',
      sourceId: input.temperatureLogId,
      reason,
      at: now,
      userId: actor.userId,
      userName: actor.userName,
    });
    if ('error' in transitioned) {
      return { held: false, error: transitioned.error, foodSafetyStatus };
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
    held = true;
    foodSafetyStatus = transitioned.foodSafetyStatus;
    await writeAuditLog(db, {
      tenantId: input.tenantId,
      action: 'FOOD_SAFETY_HOLD',
      entityType: 'production_batch',
      entityId: batchId,
      summary: `Batch ${batch.batchNo || batchId} → HOLD dari suhu ${TEMP_STAGE_LABELS[input.stage] || input.stage}`,
      metadata: {
        sourceType: 'TEMPERATURE',
        sourceId: input.temperatureLogId,
        stage: input.stage,
        alertStatus: input.alertStatus,
        suhuC: input.suhuC,
      },
      userId: actor.userId,
      userName: actor.userName,
    });
  }

  let kaIssue: ApplyTempHoldResult['kaIssue'];
  if (input.openSafetyCase !== false) {
    try {
      const sourceKey = `temp-hold:${input.temperatureLogId}`;
      const ensured = await ensureOpenKaIssue(db, {
        tenantId: input.tenantId,
        sourceKey,
        title: `Suhu hold · ${batch.batchNo || batchId}`,
        category: 'FOOD',
        caseKind: 'BREACH',
        severity: input.alertStatus === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
        description: reason,
        kitchenId: input.kitchenId || batch.kitchenId,
        kitchenNama: input.kitchenNama || batch.kitchenNama,
        batchId,
        planId: batch.productionPlanId,
        sourceHref: '/food-production/cold-chain',
        actor,
      });
      if (!ensured.created && !ensured.case.batchId) {
        await db.collection(KA_SAFETY_CASES_COLLECTION).updateOne(
          { id: ensured.case.id, tenantId: input.tenantId },
          {
            $set: {
              batchId,
              planId: batch.productionPlanId || undefined,
              updatedAt: now,
            },
          },
        );
      }
      kaIssue = {
        noDokumen: ensured.case.noDokumen,
        created: ensured.created,
        skipped: ensured.skipped,
      };
      if (ensured.created) {
        await writeAuditLog(db, {
          tenantId: input.tenantId,
          action: 'KA_CASE_CREATE',
          entityType: 'ka_safety_case',
          entityId: ensured.case.id,
          summary: `Auto Issue ${ensured.case.noDokumen} dari suhu HOLD`,
          userId: actor.userId,
          userName: actor.userName,
        });
      }
    } catch (e) {
      console.warn(
        '[temp-hold] ensureOpenKaIssue failed:',
        e instanceof Error ? e.message : e,
      );
      kaIssue = { skipped: 'ka_error' };
    }
  }

  return {
    held,
    skipped: held ? undefined : (foodSafetyStatus === 'HOLD' ? 'already_hold' : undefined),
    foodSafetyStatus,
    kaIssue,
  };
}
