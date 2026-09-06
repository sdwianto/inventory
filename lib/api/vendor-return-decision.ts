/** ADR-006 — terapkan keputusan vendor (Terima/Tolak per baris) ke RTV. */

import type { Db } from 'mongodb';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { writeAuditLog } from '@/lib/api/audit-log';
import { VENDOR_RETURNS_COLLECTION, aggregateVendorDecision, type VendorReturnDoc } from '@/types/vendor-return';

export type VendorReturnLineDecisionInput = {
  /** Wire field — sama konvensi seperti items[].lineId di goods-return-posted (bukan invoiceLineId). */
  lineId: string;
  decision: 'ACCEPTED' | 'REJECTED';
  reason?: string;
};

export type ApplyVendorReturnDecisionInput = {
  returnId: string;
  creditNoteId?: string | null;
  lineDecisions: VendorReturnLineDecisionInput[];
  decidedBy?: { userId?: string; userName?: string };
};

export type ApplyVendorReturnDecisionResult =
  | {
    action: 'applied' | 'already_applied';
    returnId: string;
    vendorDecision: string;
  }
  | { error: string; status: number; code?: string };

export async function applyVendorReturnDecision(
  db: Db,
  tenantId: string,
  payload: ApplyVendorReturnDecisionInput,
): Promise<ApplyVendorReturnDecisionResult> {
  const returnId = String(payload.returnId || '').trim();
  if (!returnId) return { error: 'returnId wajib', status: 400, code: 'VALIDATION' };
  if (!payload.lineDecisions?.length) {
    return { error: 'lineDecisions wajib minimal 1 baris', status: 400, code: 'VALIDATION' };
  }

  const doc = await db.collection(VENDOR_RETURNS_COLLECTION).findOne({
    ...tenantIdMatchFilter(tenantId),
    id: returnId,
  }) as VendorReturnDoc | null;
  if (!doc) return { error: 'Retur vendor tidak ditemukan', status: 404, code: 'NOT_FOUND' };

  const claimedCreditNoteId = String(payload.creditNoteId || '').trim();
  if (claimedCreditNoteId && String(doc.creditNoteId || '') !== claimedCreditNoteId) {
    return { error: 'creditNoteId tidak cocok dengan retur ini', status: 409, code: 'CONFLICT' };
  }
  if (doc.status !== 'POSTED') {
    return { error: 'RTV belum posting — tidak mungkin ada keputusan vendor', status: 400, code: 'VALIDATION' };
  }

  const items = Array.isArray(doc.items) ? doc.items : [];
  const byLineId = new Map(items.map((it) => [String(it.invoiceLineId || ''), it]));

  const arrayFilters: Record<string, unknown>[] = [];
  const setFields: Record<string, unknown> = {};
  let matchedCount = 0;
  let changedCount = 0;
  payload.lineDecisions.forEach((it, idx) => {
    const lineId = String(it.lineId || '').trim();
    if (!lineId) return;
    const line = byLineId.get(lineId);
    if (!line) return;
    matchedCount += 1;
    if (line.vendorDecision === it.decision) return; // idempotent per baris — replay aman.
    const filterId = `line${idx}`;
    arrayFilters.push({ [`${filterId}.invoiceLineId`]: lineId });
    setFields[`items.$[${filterId}].vendorDecision`] = it.decision;
    setFields[`items.$[${filterId}].vendorDecisionReason`] = it.reason || null;
    changedCount += 1;
  });

  // Tidak ada satupun lineId yang cocok dengan baris RTV ini — bukan replay yang
  // sah, melainkan indikasi returnId/creditNoteId salah pasangan atau data lineId korup.
  if (matchedCount === 0) {
    return {
      error: 'Tidak ada baris RTV yang cocok dengan lineDecisions yang dikirim',
      status: 400,
      code: 'VALIDATION',
    };
  }

  // Semua baris yang cocok sudah punya keputusan yang sama persis (replay murni) —
  // jangan tulis ulang vendorDecisionAt/vendorDecisionBy atau audit log ganda.
  if (changedCount === 0) {
    return { action: 'already_applied', returnId, vendorDecision: String(doc.vendorDecision || 'NONE') };
  }

  await db.collection(VENDOR_RETURNS_COLLECTION).updateOne(
    { id: returnId },
    { $set: setFields },
    { arrayFilters },
  );

  const refreshed = await db.collection(VENDOR_RETURNS_COLLECTION).findOne(
    { id: returnId },
    { projection: { items: 1 } },
  );
  const refreshedItems = Array.isArray(refreshed?.items) ? refreshed.items : items;
  const aggregate = aggregateVendorDecision(refreshedItems);

  const now = new Date();
  await db.collection(VENDOR_RETURNS_COLLECTION).updateOne(
    { id: returnId },
    {
      $set: {
        vendorDecision: aggregate,
        vendorDecisionAt: now,
        vendorDecisionBy: payload.decidedBy || null,
        updatedAt: now,
      },
    },
  );

  await writeAuditLog(db, {
    tenantId,
    action: 'VENDOR_RETURN_DECISION_APPLIED',
    entityType: 'vendor_return',
    entityId: returnId,
    summary: `Keputusan vendor diterapkan ke RTV ${doc.noReturn} (${aggregate})`,
    metadata: { lineDecisions: payload.lineDecisions, vendorDecision: aggregate },
    userId: payload.decidedBy?.userId,
    userName: payload.decidedBy?.userName,
  });

  return { action: 'applied', returnId, vendorDecision: aggregate };
}
