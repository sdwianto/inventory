/**
 * Gelombang C — pastikan Issue HOLD punya satu follow-up OPEN/DONE
 * agar operator langsung unggah bukti (satu FU aktif per case).
 */

import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { KA_DOC_TYPES, appendKaHistory } from '@/lib/kitchen-assurance/document';
import { nextKaDocNumber } from '@/lib/kitchen-assurance/document-number';
import {
  KA_ACTIVE_FOLLOW_UP_STATUSES,
  KA_FOLLOW_UPS_COLLECTION,
  type KaFollowUpDoc,
} from '@/lib/kitchen-assurance/follow-up';
import {
  KA_SAFETY_CASES_COLLECTION,
  buildKaResolutionFollowUpStamp,
  type KaSafetyCaseDoc,
} from '@/lib/kitchen-assurance/safety-case';
import { writeAuditLog } from '@/lib/api/audit-log';

export type EnsureOpenFollowUpResult = {
  created: boolean;
  skipped?: string;
  followUp: Pick<KaFollowUpDoc, 'id' | 'noDokumen' | 'status'>;
};

export async function ensureOpenFollowUpForCase(
  db: Db,
  input: {
    tenantId: string;
    safetyCase: Pick<
      KaSafetyCaseDoc,
      'id' | 'noDokumen' | 'title' | 'category' | 'kitchenId' | 'kitchenNama' | 'status' | 'history'
    >;
    title?: string;
    description?: string;
    priority?: KaFollowUpDoc['priority'];
    actor?: { userId?: string; userName?: string };
  },
): Promise<EnsureOpenFollowUpResult> {
  const tenantId = String(input.tenantId || '').trim();
  const caseId = String(input.safetyCase.id || '').trim();
  if (!tenantId || !caseId) throw new Error('tenantId dan safetyCase.id wajib');

  const existing = await db.collection(KA_FOLLOW_UPS_COLLECTION).findOne({
    tenantId,
    safetyCaseId: caseId,
    status: { $in: [...KA_ACTIVE_FOLLOW_UP_STATUSES] },
  }) as KaFollowUpDoc | null;
  if (existing) {
    return {
      created: false,
      skipped: 'active_fu_exists',
      followUp: { id: existing.id, noDokumen: existing.noDokumen, status: existing.status },
    };
  }

  const now = new Date();
  const actor = input.actor || {};
  const fu: KaFollowUpDoc = {
    id: uuidv4(),
    tenantId,
    noDokumen: await nextKaDocNumber(db, tenantId, KA_DOC_TYPES.FOLLOW_UP),
    safetyCaseId: caseId,
    safetyCaseNo: input.safetyCase.noDokumen,
    category: input.safetyCase.category,
    kitchenId: input.safetyCase.kitchenId,
    kitchenNama: input.safetyCase.kitchenNama,
    title: String(input.title || `Follow-up: ${input.safetyCase.title}`).trim(),
    description: String(input.description || '').trim() || undefined,
    priority: input.priority || 'CRITICAL',
    evidenceMedia: [],
    status: 'OPEN',
    history: appendKaHistory([], {
      at: now,
      fromStatus: null,
      toStatus: 'OPEN',
      userId: actor.userId,
      userName: actor.userName,
      note: 'Auto follow-up dari HACCP HOLD',
    }),
    createdAt: now,
    updatedAt: now,
    createdBy: actor.userId,
    createdByName: actor.userName,
  };

  try {
    await db.collection(KA_FOLLOW_UPS_COLLECTION).insertOne(fu);
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 11000) {
      const again = await db.collection(KA_FOLLOW_UPS_COLLECTION).findOne({
        tenantId,
        safetyCaseId: caseId,
        status: { $in: [...KA_ACTIVE_FOLLOW_UP_STATUSES] },
      }) as KaFollowUpDoc | null;
      if (again) {
        return {
          created: false,
          skipped: 'active_fu_exists',
          followUp: { id: again.id, noDokumen: again.noDokumen, status: again.status },
        };
      }
    }
    throw e;
  }

  const stamp = buildKaResolutionFollowUpStamp(fu);
  const casePatch: Record<string, unknown> = {
    updatedAt: now,
    ...stamp,
  };
  if (input.safetyCase.status === 'OPEN') {
    casePatch.status = 'IN_PROGRESS';
    casePatch.history = appendKaHistory(input.safetyCase.history, {
      at: now,
      fromStatus: 'OPEN',
      toStatus: 'IN_PROGRESS',
      userId: actor.userId,
      userName: actor.userName,
      note: `Follow-up ${fu.noDokumen} dibuat (HACCP HOLD)`,
    });
  }
  await db.collection(KA_SAFETY_CASES_COLLECTION).updateOne(
    { tenantId, id: caseId },
    { $set: casePatch },
  );

  await writeAuditLog(db, {
    tenantId,
    action: 'KA_FOLLOW_UP_CREATE',
    entityType: 'ka_follow_up',
    entityId: fu.id,
    summary: `Follow-up ${fu.noDokumen} dari ${input.safetyCase.noDokumen} (HACCP HOLD)`,
    userId: actor.userId,
    userName: actor.userName,
  });

  return {
    created: true,
    followUp: { id: fu.id, noDokumen: fu.noDokumen, status: fu.status },
  };
}
