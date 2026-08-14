/**
 * ADR-004 P0D — tahan production batch saat HACCP holdOnFail+FAIL disimpan.
 * HOLD terjadi di titik save (termasuk DRAFT), bukan menunggu COMPLETED.
 */

import type { Db } from 'mongodb';
import {
  buildHaccpHoldReason,
  hasHaccpHoldCandidate,
  listHaccpHoldFailLabels,
  type HaccpCategory,
  type HaccpResultItem,
  type HaccpTemplateItem,
} from '@/lib/food-production/haccp';
import {
  PRODUCTION_BATCHES_COLLECTION,
  applyFoodSafetyTransition,
  effectiveFoodSafetyStatus,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import { ensureOpenKaIssue } from '@/lib/kitchen-assurance/auto-issue';
import { ensureOpenFollowUpForCase } from '@/lib/kitchen-assurance/auto-follow-up';
import { KA_SAFETY_CASES_COLLECTION } from '@/lib/kitchen-assurance/safety-case';
import { writeAuditLog } from '@/lib/api/audit-log';
import { buildHaccpHoldRepairHrefs } from '@/lib/food-safety/hold-repair-href';

export type HaccpBatchHoldActor = {
  userId?: string;
  userName?: string;
};

export type ApplyHaccpHoldInput = {
  tenantId: string;
  productionBatchId: string;
  haccpResultId: string;
  haccpNoDokumen?: string;
  items: HaccpResultItem[];
  templateItems: HaccpTemplateItem[];
  category?: HaccpCategory | string | null;
  actor?: HaccpBatchHoldActor;
  /** Default true — buat KA safety case idempoten (ADR-004 §7). */
  openSafetyCase?: boolean;
};

export type ApplyHaccpHoldResult = {
  held: boolean;
  skipped?: string;
  foodSafetyStatus?: string;
  kaIssue?: {
    id?: string;
    noDokumen?: string;
    created?: boolean;
    skipped?: string;
    /** Deep-link Gelombang C — Temuan dengan konteks case + batch. */
    temuanHref?: string;
    /** Langsung ke unggah bukti follow-up (≤2 klik). */
    followUpHref?: string;
    followUpId?: string;
    followUpNo?: string;
  };
  error?: string;
};

/**
 * Tahan batch bila ada holdOnFail+FAIL.
 * Idempoten: batch yang sudah HOLD tidak menambah history ulang.
 * Kegagalan KA tidak menggagalkan penahanan batch.
 */
export async function applyHaccpHoldToBatch(
  db: Db,
  input: ApplyHaccpHoldInput,
): Promise<ApplyHaccpHoldResult> {
  const batchId = String(input.productionBatchId || '').trim();
  if (!batchId) return { held: false, skipped: 'no_batch' };

  if (!hasHaccpHoldCandidate(input.items, input.templateItems, input.category)) {
    return { held: false, skipped: 'no_candidate' };
  }

  const labels = listHaccpHoldFailLabels(input.items, input.templateItems, input.category);
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

  if (foodSafetyStatus === 'HOLD') {
    // Sudah ditahan — jangan spam history; tetap pastikan safety case ada.
  } else {
    const reason = buildHaccpHoldReason(labels, {
      noDokumen: input.haccpNoDokumen,
      batchNo: batch.batchNo,
    });
    const transitioned = applyFoodSafetyTransition(batch, {
      to: 'HOLD',
      sourceType: 'HACCP',
      sourceId: input.haccpResultId,
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
      summary: `Batch ${batch.batchNo || batchId} → HOLD dari HACCP ${input.haccpNoDokumen || input.haccpResultId}`,
      metadata: {
        sourceType: 'HACCP',
        sourceId: input.haccpResultId,
        failedItems: labels,
      },
      userId: actor.userId,
      userName: actor.userName,
    });
  }

  let kaIssue: ApplyHaccpHoldResult['kaIssue'];
  if (input.openSafetyCase !== false) {
    try {
      const sourceKey = `haccp-hold:${input.haccpResultId}`;
      const temuanHrefBase = `/kitchen-assurance/temuan?batch=${encodeURIComponent(batchId)}`;
      const ensured = await ensureOpenKaIssue(db, {
        tenantId: input.tenantId,
        sourceKey,
        title: `HACCP hold · ${batch.batchNo || batchId}`,
        category: 'FOOD',
        caseKind: 'BREACH',
        severity: 'CRITICAL',
        description: buildHaccpHoldReason(labels, {
          noDokumen: input.haccpNoDokumen,
          batchNo: batch.batchNo,
        }),
        kitchenId: batch.kitchenId,
        kitchenNama: batch.kitchenNama,
        batchId,
        planId: batch.productionPlanId,
        sourceHref: temuanHrefBase,
        actor,
      });
      // Backfill batchId pada case lama yang dibuat sebelum field diisi.
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
      let followUpId: string | undefined;
      let followUpNo: string | undefined;
      try {
        const fu = await ensureOpenFollowUpForCase(db, {
          tenantId: input.tenantId,
          safetyCase: ensured.case,
          title: `Perbaikan HACCP · ${batch.batchNo || batchId}`,
          description: buildHaccpHoldReason(labels, {
            noDokumen: input.haccpNoDokumen,
            batchNo: batch.batchNo,
          }),
          priority: 'CRITICAL',
          actor,
        });
        followUpId = fu.followUp.id;
        followUpNo = fu.followUp.noDokumen;
      } catch (fuErr) {
        console.warn(
          '[haccp-hold] ensureOpenFollowUpForCase failed:',
          fuErr instanceof Error ? fuErr.message : fuErr,
        );
      }
      const hrefs = buildHaccpHoldRepairHrefs({
        caseId: ensured.case.id,
        batchId,
        followUpId,
      });
      // Perbarui sourceHref dengan caseId setelah case tersedia.
      if (ensured.case.sourceHref !== hrefs.temuanHref) {
        await db.collection(KA_SAFETY_CASES_COLLECTION).updateOne(
          { id: ensured.case.id, tenantId: input.tenantId },
          { $set: { sourceHref: hrefs.temuanHref, updatedAt: now } },
        );
      }
      kaIssue = {
        id: ensured.case.id,
        noDokumen: ensured.case.noDokumen,
        created: ensured.created,
        skipped: ensured.skipped,
        temuanHref: hrefs.temuanHref,
        followUpHref: hrefs.followUpHref,
        followUpId,
        followUpNo,
      };
      if (ensured.created) {
        await writeAuditLog(db, {
          tenantId: input.tenantId,
          action: 'KA_CASE_CREATE',
          entityType: 'ka_safety_case',
          entityId: ensured.case.id,
          summary: `Auto Issue ${ensured.case.noDokumen} dari HACCP HOLD`,
          userId: actor.userId,
          userName: actor.userName,
        });
      }
    } catch (e) {
      console.warn(
        '[haccp-hold] ensureOpenKaIssue failed:',
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
