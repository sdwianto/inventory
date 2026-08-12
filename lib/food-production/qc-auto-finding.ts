/**
 * ADR-004 Fase 2 — auto-finding KA saat QC/Prerequisite FAIL (bukan hanya holdOnFail).
 * Prerequisite (lingkungan) → proposed hold bila ada kandidat batch; tidak auto-HOLD.
 */

import type { Db } from 'mongodb';
import {
  hasQcHoldCandidate,
  type QcCategory,
  type QcResultItem,
  type QcTemplateItem,
} from '@/lib/food-production/qc';
import { ensureOpenKaIssue } from '@/lib/kitchen-assurance/auto-issue';
import { resolveProposedHoldBatchIds } from '@/lib/food-production/qc-batch-hold';
import { writeAuditLog } from '@/lib/api/audit-log';

export type QcFindingActor = { userId?: string; userName?: string };

export type ApplyQcFindingInput = {
  tenantId: string;
  qcResultId: string;
  qcNoDokumen?: string;
  category: QcCategory | string;
  items: QcResultItem[];
  templateItems: QcTemplateItem[];
  productionBatchId?: string;
  productionPlanId?: string;
  kitchenId?: string;
  kitchenNama?: string;
  tanggal?: string;
  programId?: string;
  requirementId?: string;
  actor?: QcFindingActor;
};

export type ApplyQcFindingResult = {
  raised: boolean;
  skipped?: string;
  failCount?: number;
  proposedHoldBatchIds?: string[];
  kaIssue?: { noDokumen?: string; created?: boolean; skipped?: string };
};

export function listQcFailLabels(
  items: QcResultItem[],
  templateItems?: QcTemplateItem[],
): string[] {
  const byKey = new Map((templateItems || []).map((t) => [t.key, t]));
  const labels: string[] = [];
  for (const item of items) {
    if (item.result !== 'FAIL') continue;
    const tpl = byKey.get(item.key);
    labels.push(item.label || tpl?.label || item.key);
  }
  return labels;
}

/**
 * Buka Safety Case idempoten untuk setiap QC yang punya FAIL.
 * Skip bila holdOnFail sudah memicu finding di jalur HOLD (sourceKey berbeda tetap OK —
 * hold memakai qc-hold:, finding memakai qc-fail:).
 */
export async function applyQcFindingOnSave(
  db: Db,
  input: ApplyQcFindingInput,
): Promise<ApplyQcFindingResult> {
  const labels = listQcFailLabels(input.items, input.templateItems);
  if (!labels.length) return { raised: false, skipped: 'no_fail', failCount: 0 };

  // Bila holdOnFail sudah menahan / mengusulkan, finding hold sudah cukup — jangan spam issue kedua.
  if (hasQcHoldCandidate(input.items, input.templateItems)) {
    return { raised: false, skipped: 'covered_by_hold', failCount: labels.length };
  }

  const actor = input.actor || {};
  const isPrerequisite = String(input.category || '').toUpperCase() === 'PREREQUISITE';
  const reason = [
    isPrerequisite ? 'Prerequisite FAIL' : 'QC FAIL',
    labels.join(', '),
    input.qcNoDokumen ? `dok ${input.qcNoDokumen}` : '',
  ].filter(Boolean).join(' · ');

  let proposedHoldBatchIds: string[] | undefined;
  if (isPrerequisite || !String(input.productionBatchId || '').trim()) {
    proposedHoldBatchIds = await resolveProposedHoldBatchIds(db, {
      tenantId: input.tenantId,
      productionPlanId: input.productionPlanId,
      kitchenId: input.kitchenId,
      tanggal: input.tanggal,
    });
  }

  try {
    const sourceKey = `qc-fail:${input.qcResultId}`;
    const ensured = await ensureOpenKaIssue(db, {
      tenantId: input.tenantId,
      sourceKey,
      title: `${isPrerequisite ? 'Prerequisite' : 'QC'} FAIL · ${input.qcNoDokumen || input.qcResultId}`,
      category: 'FOOD',
      caseKind: 'NONCONFORMANCE',
      severity: isPrerequisite ? 'HIGH' : 'MEDIUM',
      description: reason,
      kitchenId: input.kitchenId,
      kitchenNama: input.kitchenNama,
      batchId: input.productionBatchId || undefined,
      planId: input.productionPlanId,
      proposedHoldBatchIds: proposedHoldBatchIds?.length ? proposedHoldBatchIds : undefined,
      sourceHref: isPrerequisite ? '/food-production/prerequisite' : '/food-production/qc',
      actor,
    });

    if (ensured.created) {
      await writeAuditLog(db, {
        tenantId: input.tenantId,
        action: 'KA_CASE_CREATE',
        entityType: 'ka_safety_case',
        entityId: ensured.case.id,
        summary: `Auto Issue ${ensured.case.noDokumen} dari ${isPrerequisite ? 'Prerequisite' : 'QC'} FAIL`,
        metadata: {
          sourceKey,
          programId: input.programId,
          requirementId: input.requirementId,
          failLabels: labels,
        },
        userId: actor.userId,
        userName: actor.userName,
      });
    }

    return {
      raised: true,
      failCount: labels.length,
      proposedHoldBatchIds,
      kaIssue: {
        noDokumen: ensured.case.noDokumen,
        created: ensured.created,
        skipped: ensured.skipped,
      },
    };
  } catch (e) {
    console.warn(
      '[qc-fail] ensureOpenKaIssue failed:',
      e instanceof Error ? e.message : e,
    );
    return {
      raised: false,
      failCount: labels.length,
      skipped: 'ka_error',
      kaIssue: { skipped: 'ka_error' },
    };
  }
}
