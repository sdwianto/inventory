/**
 * ADR-004 P0F — QC holdOnFail+FAIL:
 *   + productionBatchId → auto HOLD batch
 *   − productionBatchId → Safety Case + proposedHoldBatchIds[] (tidak auto-HOLD)
 */

import type { Db } from 'mongodb';
import {
  buildQcHoldReason,
  hasQcHoldCandidate,
  listQcHoldFailLabels,
  type QcResultItem,
  type QcTemplateItem,
} from '@/lib/food-production/qc';
import {
  PRODUCTION_BATCHES_COLLECTION,
  applyFoodSafetyTransition,
  effectiveFoodSafetyStatus,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import { ensureOpenKaIssue } from '@/lib/kitchen-assurance/auto-issue';
import { KA_SAFETY_CASES_COLLECTION } from '@/lib/kitchen-assurance/safety-case';
import { writeAuditLog } from '@/lib/api/audit-log';

export type QcBatchHoldActor = {
  userId?: string;
  userName?: string;
};

export type ApplyQcHoldInput = {
  tenantId: string;
  productionBatchId?: string | null;
  qcResultId: string;
  qcNoDokumen?: string;
  items: QcResultItem[];
  templateItems: QcTemplateItem[];
  /** ADR-004 Fase 2 — PREREQUISITE tidak pernah auto-HOLD. */
  category?: string;
  productionPlanId?: string;
  kitchenId?: string;
  kitchenNama?: string;
  tanggal?: string;
  actor?: QcBatchHoldActor;
  openSafetyCase?: boolean;
};

export type ApplyQcHoldResult = {
  held: boolean;
  proposed?: boolean;
  skipped?: string;
  foodSafetyStatus?: string;
  proposedHoldBatchIds?: string[];
  kaIssue?: { noDokumen?: string; created?: boolean; skipped?: string };
  error?: string;
};

/**
 * Usulan batch inferensial: plan yang sama, atau dapur + tanggal produksi.
 * Fallback: batch ACTIVE di dapur yang sama (inferensi longgar).
 * Tidak pernah menahan otomatis.
 */
export async function resolveProposedHoldBatchIds(
  db: Db,
  input: {
    tenantId: string;
    productionPlanId?: string;
    kitchenId?: string;
    tanggal?: string;
  },
): Promise<string[]> {
  const filter: Record<string, unknown> = {
    tenantId: input.tenantId,
    status: 'ACTIVE',
  };
  if (input.productionPlanId?.trim()) {
    filter.productionPlanId = input.productionPlanId.trim();
  } else if (input.kitchenId?.trim() && input.tanggal?.trim()) {
    filter.kitchenId = input.kitchenId.trim();
    filter.producedAt = input.tanggal.trim();
  } else if (input.kitchenId?.trim()) {
    filter.kitchenId = input.kitchenId.trim();
  } else {
    return [];
  }
  let rows = await db.collection(PRODUCTION_BATCHES_COLLECTION)
    .find(filter, { projection: { id: 1 } })
    .limit(30)
    .toArray();
  // Tanggal ketat kosong → longgar: semua ACTIVE di dapur yang sama.
  if (
    !rows.length
    && input.kitchenId?.trim()
    && input.tanggal?.trim()
    && !input.productionPlanId?.trim()
  ) {
    rows = await db.collection(PRODUCTION_BATCHES_COLLECTION)
      .find(
        { tenantId: input.tenantId, status: 'ACTIVE', kitchenId: input.kitchenId.trim() },
        { projection: { id: 1 } },
      )
      .limit(30)
      .toArray();
  }
  return rows.map((r) => String(r.id || '').trim()).filter(Boolean);
}

async function applyQcHoldToBatch(
  db: Db,
  input: ApplyQcHoldInput & { productionBatchId: string },
  labels: string[],
): Promise<ApplyQcHoldResult> {
  const batchId = input.productionBatchId;
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
  const reason = buildQcHoldReason(labels, {
    noDokumen: input.qcNoDokumen,
    batchNo: batch.batchNo,
  });

  if (foodSafetyStatus !== 'HOLD') {
    const transitioned = applyFoodSafetyTransition(batch, {
      to: 'HOLD',
      sourceType: 'QC',
      sourceId: input.qcResultId,
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
      summary: `Batch ${batch.batchNo || batchId} → HOLD dari QC ${input.qcNoDokumen || input.qcResultId}`,
      metadata: {
        sourceType: 'QC',
        sourceId: input.qcResultId,
        failedItems: labels,
      },
      userId: actor.userId,
      userName: actor.userName,
    });
  }

  let kaIssue: ApplyQcHoldResult['kaIssue'];
  if (input.openSafetyCase !== false) {
    try {
      const sourceKey = `qc-hold:${input.qcResultId}`;
      const ensured = await ensureOpenKaIssue(db, {
        tenantId: input.tenantId,
        sourceKey,
        title: `QC hold · ${batch.batchNo || batchId}`,
        category: 'FOOD',
        caseKind: 'NONCONFORMANCE',
        severity: 'CRITICAL',
        description: reason,
        kitchenId: input.kitchenId || batch.kitchenId,
        kitchenNama: input.kitchenNama || batch.kitchenNama,
        batchId,
        planId: batch.productionPlanId || input.productionPlanId,
        sourceHref: '/food-production/qc',
        actor,
      });
      if (!ensured.created && !ensured.case.batchId) {
        await db.collection(KA_SAFETY_CASES_COLLECTION).updateOne(
          { id: ensured.case.id, tenantId: input.tenantId },
          {
            $set: {
              batchId,
              planId: batch.productionPlanId || input.productionPlanId || undefined,
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
          summary: `Auto Issue ${ensured.case.noDokumen} dari QC HOLD`,
          userId: actor.userId,
          userName: actor.userName,
        });
      }
    } catch (e) {
      console.warn(
        '[qc-hold] ensureOpenKaIssue failed:',
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

async function applyQcProposedHold(
  db: Db,
  input: ApplyQcHoldInput,
  labels: string[],
): Promise<ApplyQcHoldResult> {
  const proposedHoldBatchIds = await resolveProposedHoldBatchIds(db, {
    tenantId: input.tenantId,
    productionPlanId: input.productionPlanId,
    kitchenId: input.kitchenId,
    tanggal: input.tanggal,
  });
  const reason = buildQcHoldReason(labels, { noDokumen: input.qcNoDokumen });
  const actor = input.actor || {};
  const now = new Date();

  let kaIssue: ApplyQcHoldResult['kaIssue'];
  if (input.openSafetyCase !== false) {
    try {
      const sourceKey = `qc-proposed-hold:${input.qcResultId}`;
      const ensured = await ensureOpenKaIssue(db, {
        tenantId: input.tenantId,
        sourceKey,
        title: `QC usulan hold · ${input.qcNoDokumen || input.qcResultId}`,
        category: 'FOOD',
        caseKind: 'NONCONFORMANCE',
        severity: 'HIGH',
        description: `${reason} · tanpa productionBatchId — butuh konfirmasi supervisor`,
        kitchenId: input.kitchenId,
        kitchenNama: input.kitchenNama,
        planId: input.productionPlanId,
        proposedHoldBatchIds,
        sourceHref: '/food-production/qc',
        actor,
      });
      // Backfill usulan bila case sudah ada tanpa daftar batch.
      if (
        !ensured.created
        && proposedHoldBatchIds.length
        && !(ensured.case.proposedHoldBatchIds?.length)
      ) {
        await db.collection(KA_SAFETY_CASES_COLLECTION).updateOne(
          { id: ensured.case.id, tenantId: input.tenantId },
          {
            $set: {
              proposedHoldBatchIds,
              'resolution.type': 'HOLD_BATCH',
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
          summary: `Auto Issue ${ensured.case.noDokumen} dari QC proposed HOLD`,
          metadata: { proposedHoldBatchIds },
          userId: actor.userId,
          userName: actor.userName,
        });
      }
    } catch (e) {
      console.warn(
        '[qc-proposed-hold] ensureOpenKaIssue failed:',
        e instanceof Error ? e.message : e,
      );
      kaIssue = { skipped: 'ka_error' };
    }
  }

  return {
    held: false,
    proposed: true,
    skipped: 'no_batch',
    proposedHoldBatchIds,
    kaIssue,
  };
}

/**
 * Titik masuk P0F saat QC disimpan.
 * ADR-004 Fase 2: category PREREQUISITE → selalu proposed hold (tidak auto-HOLD).
 * Idempoten per qcResultId via sourceKey KA.
 */
export async function applyQcFoodSafetyOnSave(
  db: Db,
  input: ApplyQcHoldInput,
): Promise<ApplyQcHoldResult> {
  if (!hasQcHoldCandidate(input.items, input.templateItems)) {
    return { held: false, skipped: 'no_candidate' };
  }
  const labels = listQcHoldFailLabels(input.items, input.templateItems);
  const isPrerequisite = String(input.category || '').toUpperCase() === 'PREREQUISITE';
  const batchId = String(input.productionBatchId || '').trim();

  // Blast radius: prerequisite terikat lingkungan — usulan, bukan HOLD deterministik.
  if (isPrerequisite) {
    const proposed = await applyQcProposedHold(db, input, labels);
    if (batchId && !(proposed.proposedHoldBatchIds || []).includes(batchId)) {
      return {
        ...proposed,
        proposedHoldBatchIds: [batchId, ...(proposed.proposedHoldBatchIds || [])],
      };
    }
    return proposed;
  }

  if (batchId) {
    return applyQcHoldToBatch(db, { ...input, productionBatchId: batchId }, labels);
  }
  return applyQcProposedHold(db, input, labels);
}
