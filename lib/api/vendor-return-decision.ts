/** ADR-006 — terapkan keputusan vendor (Terima/Tolak per baris) ke RTV. */

import type { Db } from 'mongodb';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { postStockMutation } from '@/lib/api/stock-mutation';
import { createJournalIfNotExists } from '@/lib/api/journal';
import { buildVendorReturnTransitRestoreJournalLines } from '@/lib/api/journal-lines';
import { planFefoRestore } from '@/lib/food-production/fefo-allocate';
import { restoreIngredientLotsFromAllocations } from '@/lib/food-production/ingredient-lot-consume';
import { VENDOR_RETURNS_COLLECTION, aggregateVendorDecision, type VendorReturnDoc, type VendorReturnLine } from '@/types/vendor-return';

/** Cocokkan alokasi FEFO Post ke baris yang ditolak — prioritaskan identity baris, bukan SKU+gudang. */
export function findLotConsumeForRejectedLine(
  lotConsume: VendorReturnDoc['lotConsume'] | undefined,
  line: Pick<VendorReturnLine, 'invoiceLineId' | 'lineId' | 'localStokId' | 'gudangKode'>,
): NonNullable<VendorReturnDoc['lotConsume']>[number] | undefined {
  const list = lotConsume || [];
  if (!list.length) return undefined;

  const inv = String(line.invoiceLineId || '').trim();
  if (inv) {
    const byInv = list.find((lc) => String(lc.invoiceLineId || '').trim() === inv);
    if (byInv) return byInv;
  }

  const lid = String(line.lineId || '').trim();
  if (lid) {
    const byLine = list.find((lc) => String(lc.lineId || '').trim() === lid);
    if (byLine) return byLine;
  }

  // Fallback hanya jika unik — hindari restore salah saat 2 baris SKU+gudang sama.
  const matches = list.filter((lc) => (
    String(lc.localStokId) === String(line.localStokId)
    && String(lc.warehouseKode) === String(line.gudangKode)
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

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
  // ADR-006 — D2 keluarkan stok TANPA SYARAT saat RTV posting; D3 tidak ada reversal
  // finansial utk baris ditolak. Stok fisik dikembalikan di sini (D5).
  // Urutan kritis non-TX: restore stok DULU, baru stamp keputusan — kalau stamp dulu
  // lalu gagal restore, replay menganggap sudah applied dan stok tidak pernah kembali.
  const newlyRejectedLines: VendorReturnLine[] = [];
  let matchedCount = 0;
  let changedCount = 0;
  payload.lineDecisions.forEach((it, idx) => {
    const lineId = String(it.lineId || '').trim();
    if (!lineId) return;
    const line = byLineId.get(lineId);
    if (!line) return;
    matchedCount += 1;
    const alreadySame = line.vendorDecision === it.decision;
    const needsHealRestore = it.decision === 'REJECTED'
      && alreadySame
      && !line.stockRestoredAt;
    const needsHealTransit = it.decision === 'REJECTED'
      && !!doc.transitAppliedAt
      && !line.transitRestoredAt;
    if (alreadySame && !needsHealRestore && !needsHealTransit) return;
    const filterId = `line${idx}`;
    arrayFilters.push({ [`${filterId}.invoiceLineId`]: lineId });
    if (!alreadySame) {
      setFields[`items.$[${filterId}].vendorDecision`] = it.decision;
      setFields[`items.$[${filterId}].vendorDecisionReason`] = it.reason || null;
      changedCount += 1;
    }
    if (it.decision === 'REJECTED' && (!line.stockRestoredAt || needsHealTransit)) {
      newlyRejectedLines.push(line);
    }
  });

  if (matchedCount === 0) {
    return {
      error: 'Tidak ada baris RTV yang cocok dengan lineDecisions yang dikirim',
      status: 400,
      code: 'VALIDATION',
    };
  }

  if (changedCount === 0 && newlyRejectedLines.length === 0) {
    // Heal sticky PENDING header: baris sudah diputus tapi aggregate belum ter-update
    // (crash antara TX baris dan update dokumen).
    const healedAgg = aggregateVendorDecision(items);
    const header = String(doc.vendorDecision || 'NONE');
    if (header === 'PENDING' && healedAgg !== 'PENDING' && healedAgg !== 'NONE') {
      const now = new Date();
      await db.collection(VENDOR_RETURNS_COLLECTION).updateOne(
        { id: returnId },
        {
          $set: {
            vendorDecision: healedAgg,
            vendorDecisionAt: doc.vendorDecisionAt || now,
            vendorDecisionBy: doc.vendorDecisionBy || payload.decidedBy || null,
            updatedAt: now,
          },
        },
      );
      return { action: 'already_applied', returnId, vendorDecision: healedAgg };
    }
    return { action: 'already_applied', returnId, vendorDecision: header };
  }

  try {
    await runInTransactionOrFallback(async ({ db: txDb, session }) => {
      // 1) Restore stok + reverse transit GL untuk baris REJECTED.
      for (const line of newlyRejectedLines) {
        const qtyBase = parseFloat(String(line.qtyBase)) || 0;
        const inv = String(line.invoiceLineId || '').trim();
        const lid = String(line.lineId || '').trim();
        const markRestored = async (extra?: Record<string, unknown>) => {
          const filter = inv
            ? { 'rest.invoiceLineId': inv }
            : lid
              ? { 'rest.lineId': lid }
              : null;
          if (!filter) return;
          await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
            { id: returnId },
            {
              $set: {
                'items.$[rest].stockRestoredAt': new Date(),
                ...Object.fromEntries(
                  Object.entries(extra || {}).map(([k, v]) => [`items.$[rest].${k}`, v]),
                ),
                updatedAt: new Date(),
              },
            },
            { arrayFilters: [filter], ...txOpts(session) },
          );
        };

        if (!line.stockRestoredAt) {
          if (qtyBase <= 0) {
            await markRestored();
          } else {
            const mut = await postStockMutation(txDb, {
              tenantId,
              productId: line.localStokId,
              warehouseKode: line.gudangKode,
              deltaQtyBase: qtyBase,
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

            const prior = findLotConsumeForRejectedLine(doc.lotConsume, line);
            if (prior?.allocations?.length) {
              const restores = planFefoRestore(qtyBase, prior.allocations);
              if (restores.length) {
                await restoreIngredientLotsFromAllocations(
                  txDb,
                  {
                    tenantId,
                    stokId: line.localStokId,
                    restores,
                    noDokumen: doc.noReturn,
                    returnId: doc.id,
                  },
                  session,
                );
              }
            }
            await markRestored();
          }
        }

        // ADR-005 — reverse transit GL (skip legacy RTV tanpa transitAppliedAt).
        if (doc.transitAppliedAt && !line.transitRestoredAt) {
          const lineAmt = Math.round(parseInt(String(line.jumlah || 0), 10) || 0);
          const lineKey = inv || lid;
          if (lineAmt > 0 && lineKey) {
            const restoreLines = buildVendorReturnTransitRestoreJournalLines({
              noDoc: doc.noReturn,
              amount: lineAmt,
              lineLabel: line.localKode || lineKey,
            });
            if (restoreLines.length) {
              await createJournalIfNotExists(txDb, {
                tanggal: new Date(),
                keterangan: `Transit restore retur ${doc.noReturn} baris ${line.localKode || lineKey}`,
                sourceType: 'RTV_TRANSIT_RESTORE',
                sourceId: `${doc.id}:${lineKey}`,
                userName: payload.decidedBy?.userName || 'vendor-decision',
                details: restoreLines,
                tenantId,
              }, session);
            }
          }
          // Stamp flag — prefer invoiceLineId arrayFilter; fallback lineId.
          if (inv) {
            await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
              { id: returnId },
              {
                $set: {
                  'items.$[rest].transitRestoredAt': new Date(),
                  updatedAt: new Date(),
                },
              },
              { arrayFilters: [{ 'rest.invoiceLineId': inv }], ...txOpts(session) },
            );
          } else if (lid) {
            await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
              { id: returnId },
              {
                $set: {
                  'items.$[rest].transitRestoredAt': new Date(),
                  updatedAt: new Date(),
                },
              },
              { arrayFilters: [{ 'rest.lineId': lid }], ...txOpts(session) },
            );
          }
        }
      }

      // 2) Stamp keputusan baris (setelah stok aman).
      if (Object.keys(setFields).length > 0 && arrayFilters.length > 0) {
        await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
          { id: returnId },
          { $set: setFields },
          { arrayFilters, ...txOpts(session) },
        );
      }

      // 3) Aggregate header di TX yang sama — hindari sticky PENDING bila crash setelah baris.
      const decisionByLine = new Map(
        payload.lineDecisions.map((d) => [String(d.lineId || '').trim(), d] as const),
      );
      const mergedItems = items.map((it) => {
        const key = String(it.invoiceLineId || it.lineId || '').trim();
        const d = decisionByLine.get(key);
        if (!d) return it;
        return {
          ...it,
          vendorDecision: d.decision,
          vendorDecisionReason: d.reason || null,
        };
      });
      const aggregateInTx = aggregateVendorDecision(mergedItems);
      const nowTx = new Date();
      await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
        { id: returnId },
        {
          $set: {
            vendorDecision: aggregateInTx,
            vendorDecisionAt: nowTx,
            vendorDecisionBy: payload.decidedBy || null,
            updatedAt: nowTx,
          },
        },
        txOpts(session),
      );
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
    { projection: { items: 1, vendorDecision: 1 } },
  );
  const aggregate = String(refreshed?.vendorDecision || aggregateVendorDecision(
    Array.isArray(refreshed?.items) ? refreshed.items : items,
  ));

  // Heal-only (keputusan sudah sama, hanya restore stok yang tertunda) — jangan audit ganda.
  if (changedCount > 0) {
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
  }

  return {
    action: changedCount === 0 ? 'already_applied' : 'applied',
    returnId,
    vendorDecision: aggregate,
  };
}

export type CheckVendorReturnDecisionStatusResult =
  | {
    action: 'already_resolved' | 'still_pending' | 'applied' | 'already_applied';
    returnId: string;
    vendorDecision: string;
    hutangHeal?: Record<string, unknown> | null;
  }
  | ApplyVendorReturnDecisionResult & { hutangHeal?: Record<string, unknown> | null }
  | { error: string; status: number; code?: string; hutangHeal?: Record<string, unknown> | null };

/**
 * ADR-006 — Category B pull: buyer aktif tanya status keputusan vendor ke Sales,
 * bukan cuma pasif menunggu webhook `vendor-return-decision` (yang bisa gagal
 * terkirim/hilang tanpa Inventory pernah tahu). Juga heal hutang bila Sales CN
 * sudah POSTED tapi push credit-note-posted gagal/terlambat.
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
  if (!doc.creditNoteId) {
    return { action: 'still_pending', returnId, vendorDecision: String(doc.vendorDecision || 'PENDING') };
  }

  const pendingDecision = String(doc.vendorDecision || '') === 'PENDING';

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
      return { action: 'still_pending', returnId, vendorDecision: String(doc.vendorDecision || 'PENDING') };
    }
    const msg = e instanceof IntegrationError ? e.message : salesFetchErrorMessage(e, access.salesAppUrl);
    return { error: msg, status: 503, code: 'SALES_UNAVAILABLE' };
  }

  const nested = (data.result && typeof data.result === 'object')
    ? data.result as Record<string, unknown>
    : data;

  let decisionPart: CheckVendorReturnDecisionStatusResult;
  let decisionError: { error: string; status: number; code?: string } | null = null;
  if (!nested.decided) {
    decisionPart = {
      action: 'still_pending',
      returnId,
      vendorDecision: String(doc.vendorDecision || 'PENDING'),
    };
  } else if (!pendingDecision) {
    // Header sudah resolved — tetap heal baris (stockRestoredAt / transit) bila Sales kirim lineDecisions.
    const lineDecisions = Array.isArray(nested.lineDecisions)
      ? (nested.lineDecisions as VendorReturnLineDecisionInput[])
      : [];
    if (lineDecisions.length) {
      const healed = await applyVendorReturnDecision(db, tenantId, {
        returnId,
        creditNoteId: String(nested.creditNoteId || doc.creditNoteId || ''),
        lineDecisions,
      });
      if (!('error' in healed)) {
        decisionPart = {
          action: 'already_resolved',
          returnId,
          vendorDecision: String(healed.vendorDecision || doc.vendorDecision || 'NONE'),
        };
      } else {
        decisionPart = {
          action: 'already_resolved',
          returnId,
          vendorDecision: String(doc.vendorDecision || 'NONE'),
        };
      }
    } else {
      decisionPart = {
        action: 'already_resolved',
        returnId,
        vendorDecision: String(doc.vendorDecision || 'NONE'),
      };
    }
  } else {
    const lineDecisions = Array.isArray(nested.lineDecisions)
      ? (nested.lineDecisions as VendorReturnLineDecisionInput[])
      : [];
    if (!lineDecisions.length) {
      decisionError = {
        error: 'Sales melaporkan retur sudah diputuskan tapi tidak mengirim rincian per baris',
        status: 502,
        code: 'BAD_RESPONSE',
      };
      decisionPart = {
        action: 'still_pending',
        returnId,
        vendorDecision: String(doc.vendorDecision || 'PENDING'),
      };
    } else {
      const applied = await applyVendorReturnDecision(db, tenantId, {
        returnId,
        creditNoteId: String(nested.creditNoteId || doc.creditNoteId || ''),
        lineDecisions,
      });
      if ('error' in applied) {
        decisionError = { error: applied.error, status: applied.status, code: applied.code };
        decisionPart = {
          action: 'still_pending',
          returnId,
          vendorDecision: String(doc.vendorDecision || 'PENDING'),
        };
      } else {
        decisionPart = applied;
      }
    }
  }

  // Heal hutang tetap dijalankan meski decision apply gagal — AP vs stok independen.
  let hutangHeal: Record<string, unknown> | null = null;
  const cnStatus = String(nested.status || '');
  const cnTotal = parseInt(String(nested.total ?? nested.cnTotal ?? 0), 10) || 0;
  if (cnStatus === 'POSTED' && cnTotal > 0) {
    const invoiceId = String(nested.invoiceId || doc.vendorInvoiceId || '').trim();
    const noInvoice = String(nested.noInvoice || doc.noInvoice || '').trim();
    if (invoiceId || noInvoice) {
      const { applyCreditNoteFromVendor } = await import('@/lib/api/hutang-from-vendor');
      const acceptedItems = Array.isArray(nested.acceptedItems)
        ? nested.acceptedItems
        : Array.isArray(nested.items)
          ? nested.items
          : undefined;
      hutangHeal = await applyCreditNoteFromVendor(
        db,
        tenantId,
        {
          invoiceId: invoiceId || undefined,
          noInvoice: noInvoice || undefined,
          total: cnTotal,
          creditNoteId: String(nested.creditNoteId || doc.creditNoteId || ''),
          noCN: String(nested.noCN || doc.noCN || '') || undefined,
          source: 'inventory_return',
          noReturn: doc.noReturn,
          items: acceptedItems as never,
          postedAt: nested.postedAt ? new Date(String(nested.postedAt)) : undefined,
        },
        doc.vendorTenantId,
        {
          appliedVia: 'check-decision-pull',
          returnId: doc.id,
          clearTransit: Boolean(doc.transitAppliedAt || doc.transitJournalId),
        },
      ) as Record<string, unknown>;
    }
  }

  // Decision gagal tapi hutang mungkin sudah healed — laporkan error decision + hutangHeal.
  if (decisionError) {
    return { ...decisionError, hutangHeal };
  }
  if ('error' in decisionPart) return decisionPart;
  return { ...decisionPart, hutangHeal };
}
