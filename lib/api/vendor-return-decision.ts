/** ADR-006 — terapkan keputusan vendor (Terima/Tolak per baris) ke RTV. */

import type { Db } from 'mongodb';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { postStockMutation } from '@/lib/api/stock-mutation';
import { VENDOR_RETURNS_COLLECTION, aggregateVendorDecision, type VendorReturnDoc, type VendorReturnLine } from '@/types/vendor-return';

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
  // ADR-006 — D2 keluarkan stok TANPA SYARAT saat RTV posting, sebelum vendor sempat
  // memutuskan apa pun; D3 bilang tidak ada reversal FINANSIAL untuk baris ditolak (karena
  // belum pernah dibukukan) — tapi itu tidak berarti stok FISIK ikut-ikutan tidak pernah
  // kembali. Barang yang ditolak vendor secara riil tidak pernah benar-benar pindah tangan,
  // jadi stok gudang buyer wajib dikembalikan di sini, supaya D5 ("bebas retur ulang") juga
  // benar secara fisik, bukan cuma benar di penghitungan qty-returnable.
  const newlyRejectedLines: VendorReturnLine[] = [];
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
    if (it.decision === 'REJECTED') newlyRejectedLines.push(line);
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

  try {
    await runInTransactionOrFallback(async ({ db: txDb, session }) => {
      await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
        { id: returnId },
        { $set: setFields },
        { arrayFilters, ...txOpts(session) },
      );

      for (const line of newlyRejectedLines) {
        const qtyBase = parseFloat(String(line.qtyBase)) || 0;
        if (qtyBase <= 0) continue;
        const mut = await postStockMutation(txDb, {
          tenantId,
          productId: line.localStokId,
          warehouseKode: line.gudangKode,
          deltaQtyBase: qtyBase, // positif = masuk — kembalikan stok yang keluar saat posting.
          sourceType: 'VENDOR_RETURN_REJECTED',
          noTransaksi: doc.noReturn,
          keterangan: `Vendor tolak retur ${doc.noReturn} baris ${line.localKode || line.localStokId} — stok dikembalikan`,
          hargaSatuan: line.harga,
          qtyEntered: line.qty,
          uomId: line.uomId,
          satuan: line.satuan,
          session,
        });
        if (!mut.ok) throw new Error(mut.error);
      }
    });
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : 'Gagal mengembalikan stok utk baris yang ditolak',
      status: 409,
      code: 'STOCK_REVERSAL_FAILED',
    };
  }

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

export type CheckVendorReturnDecisionStatusResult =
  | { action: 'already_resolved' | 'still_pending'; returnId: string; vendorDecision: string }
  | ApplyVendorReturnDecisionResult;

/**
 * ADR-006 — Category B pull: buyer aktif tanya status keputusan vendor ke Sales,
 * bukan cuma pasif menunggu webhook `vendor-return-decision` (yang bisa gagal
 * terkirim/hilang tanpa Inventory pernah tahu). Dipanggil dari tombol "Cek Keputusan
 * ke Sales" di UI retur-vendor saat status masih PENDING — kalau Sales melaporkan
 * sudah diputuskan, keputusan langsung diterapkan lewat jalur yang SAMA persis
 * dengan penerima webhook (applyVendorReturnDecision), jadi hasilnya identik baik
 * lewat push maupun pull.
 */
export async function checkVendorReturnDecisionStatus(
  db: Db,
  tenantId: string,
  returnId: string,
): Promise<CheckVendorReturnDecisionStatusResult> {
  const doc = await db.collection(VENDOR_RETURNS_COLLECTION).findOne({
    ...tenantIdMatchFilter(tenantId),
    id: returnId,
  }) as VendorReturnDoc | null;
  if (!doc) return { error: 'Retur vendor tidak ditemukan', status: 404, code: 'NOT_FOUND' };
  if (doc.status !== 'POSTED') {
    return { error: 'RTV belum posting — tidak mungkin ada keputusan vendor', status: 400, code: 'VALIDATION' };
  }
  if (String(doc.vendorDecision || '') !== 'PENDING') {
    return { action: 'already_resolved', returnId, vendorDecision: String(doc.vendorDecision || 'NONE') };
  }
  if (!doc.creditNoteId) {
    return { action: 'still_pending', returnId, vendorDecision: 'PENDING' };
  }

  const { resolveSalesApiAccess } = await import('@/lib/api/integration-links');
  const access = await resolveSalesApiAccess(
    db,
    tenantId,
    doc.vendorTenantId ? String(doc.vendorTenantId) : undefined,
  );
  if (!access) {
    return { error: 'Integrasi Sales belum terhubung — tidak bisa cek status', status: 400, code: 'NOT_PAIRED' };
  }

  const { createIntegrationClient } = await import('@/lib/integration/client');
  const { IntegrationError } = await import('@/lib/integration/errors');
  const { salesFetchErrorMessage } = await import('@/lib/api/integration-common');
  const client = createIntegrationClient(db);
  let data: Record<string, unknown>;
  try {
    data = await client.lookupVendorReturnDecisionStatus({
      salesAppUrl: access.salesAppUrl,
      apiKey: access.salesApiKey,
      grnId: returnId,
      query: {
        customerTenantId: tenantId,
        returnId,
        vendorTenantId: doc.vendorTenantId ? String(doc.vendorTenantId) : undefined,
      },
    });
  } catch (e) {
    if (e instanceof IntegrationError && e.httpStatus === 404) {
      return { action: 'still_pending', returnId, vendorDecision: 'PENDING' };
    }
    const msg = e instanceof IntegrationError ? e.message : salesFetchErrorMessage(e, access.salesAppUrl);
    return { error: msg, status: 503, code: 'SALES_UNAVAILABLE' };
  }

  const nested = (data.result && typeof data.result === 'object')
    ? data.result as Record<string, unknown>
    : data;
  if (!nested.decided) {
    return { action: 'still_pending', returnId, vendorDecision: 'PENDING' };
  }

  const lineDecisions = Array.isArray(nested.lineDecisions)
    ? (nested.lineDecisions as VendorReturnLineDecisionInput[])
    : [];
  if (!lineDecisions.length) {
    return {
      error: 'Sales melaporkan retur sudah diputuskan tapi tidak mengirim rincian per baris',
      status: 502,
      code: 'BAD_RESPONSE',
    };
  }

  return applyVendorReturnDecision(db, tenantId, {
    returnId,
    creditNoteId: String(nested.creditNoteId || doc.creditNoteId || ''),
    lineDecisions,
  });
}
