/**
 * Light automation — ADR-002 P3.
 * Ensure open Issue from owner-domain exceptions (no Policy Engine).
 */

import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { KA_DOC_TYPES, appendKaHistory } from '@/lib/kitchen-assurance/document';
import { nextKaDocNumber } from '@/lib/kitchen-assurance/document-number';
import {
  KA_SAFETY_CASES_COLLECTION,
  type KaCaseKind,
  type KaSafetyCaseDoc,
} from '@/lib/kitchen-assurance/safety-case';
import type { KaCategory } from '@/lib/kitchen-assurance/categories';
import type { KaPolicySeverity } from '@/lib/kitchen-assurance/policy';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';

const OPEN_STATUSES = ['OPEN', 'IN_PROGRESS', 'PENDING_VERIFY'] as const;

export interface EnsureOpenIssueInput {
  tenantId: string;
  sourceKey: string;
  title: string;
  category: KaCategory;
  caseKind?: KaCaseKind;
  severity?: KaPolicySeverity;
  description?: string;
  kitchenId?: string;
  kitchenNama?: string;
  sourceHref?: string;
  actor?: { userId?: string; userName?: string };
}

export interface EnsureOpenIssueResult {
  created: boolean;
  skipped?: string;
  case: KaSafetyCaseDoc;
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function resolveKitchenNama(
  db: Db,
  tenantId: string,
  kitchenId?: string,
  kitchenNama?: string,
): Promise<string | undefined> {
  if (kitchenNama?.trim()) return kitchenNama.trim();
  if (!kitchenId?.trim()) return undefined;
  const k = await db.collection(KITCHENS_COLLECTION).findOne({
    tenantId,
    id: kitchenId.trim(),
  });
  return k?.nama ? String(k.nama) : undefined;
}

/** Create Issue if none open for sourceKey; otherwise return existing. */
export async function ensureOpenKaIssue(
  db: Db,
  input: EnsureOpenIssueInput,
): Promise<EnsureOpenIssueResult> {
  const sourceKey = String(input.sourceKey || '').trim();
  if (!sourceKey) throw new Error('sourceKey wajib');

  const existing = await db.collection(KA_SAFETY_CASES_COLLECTION).findOne({
    tenantId: input.tenantId,
    sourceKey,
    status: { $in: [...OPEN_STATUSES] },
  }) as KaSafetyCaseDoc | null;
  if (existing) {
    return { created: false, skipped: 'open_issue_exists', case: existing };
  }

  const now = new Date();
  const actor = input.actor || {};
  const kitchenNama = await resolveKitchenNama(
    db,
    input.tenantId,
    input.kitchenId,
    input.kitchenNama,
  );

  const doc: KaSafetyCaseDoc = {
    id: uuidv4(),
    tenantId: input.tenantId,
    noDokumen: await nextKaDocNumber(db, input.tenantId, KA_DOC_TYPES.SAFETY_CASE),
    category: input.category === 'COMPLIANCE' ? 'OPERATION' : input.category,
    caseKind: input.caseKind || 'BREACH',
    title: input.title.trim(),
    description: input.description?.trim() || undefined,
    severity: input.severity || 'HIGH',
    status: 'OPEN',
    sourceKey,
    sourceHref: input.sourceHref?.trim() || undefined,
    kitchenId: input.kitchenId?.trim() || undefined,
    kitchenNama,
    resolution: { type: 'NONE' },
    photos: [],
    loggedAt: now,
    history: appendKaHistory([], {
      at: now,
      fromStatus: null,
      toStatus: 'OPEN',
      userId: actor.userId,
      userName: actor.userName,
      note: 'Auto Issue (P3)',
    }),
    tanggal: todayYmd(),
    createdAt: now,
    updatedAt: now,
    createdBy: actor.userId,
    createdByName: actor.userName,
  };

  try {
    await db.collection(KA_SAFETY_CASES_COLLECTION).insertOne(doc);
    return { created: true, case: doc };
  } catch (e) {
    // Race: unique open sourceKey index — re-fetch winner
    const again = await db.collection(KA_SAFETY_CASES_COLLECTION).findOne({
      tenantId: input.tenantId,
      sourceKey,
      status: { $in: [...OPEN_STATUSES] },
    }) as KaSafetyCaseDoc | null;
    if (again) return { created: false, skipped: 'open_issue_exists', case: again };
    throw e;
  }
}
