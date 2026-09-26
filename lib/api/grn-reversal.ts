// Fase 3.6 — pembalik GRN lewat dokumen pembalik (RVS): ajukan → setujui (SoD) → stok keluar dari lot
// GRN, qty PO dikurangi, akrual GRNI dibalik, harga beli rata-rata dikoreksi, GRN berstatus REVERSED.
// Hanya GRN penuh; tagihan vendor harus ditolak dulu, lot harus utuh di gudang asal.

import type { AnyBulkWriteOperation, ClientSession, Db, Document } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { runInTransactionOnDb, txOpts } from '@/lib/api/transaction';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { writeAuditLog } from '@/lib/api/audit-log';
import { createJournalIfNotExists } from '@/lib/api/journal';
import { syncCpoOnGrnReversed } from '@/lib/api/cpo-status-sync';
import { reopenWrClosedByGrn } from '@/lib/api/maintenance-wr-loop';
import { syncAssetStatusFromOpenRequests } from '@/lib/api/maintenance-helpers';
import { logger } from '@/lib/api/logger';
import { productFilterById } from '@/lib/api/tenant-operational';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { buildJualPricesAfterBeliChange, reverseWeightedAvgHargaBeli } from '@/lib/api/inventory-cost';
import { INGREDIENT_LOTS_COLLECTION } from '@/lib/food-production/ingredient-lot';
import { releaseLotReservations } from '@/lib/stock-ledger/plan-reservation';
import {
  GRN_REVERSAL_SOURCE,
  loadGrnReversalLotGroups,
  postGrnReversalStock,
  type GrnReversalLotGroup,
} from '@/lib/stock-ledger/grn-reversal-stock';
import { GRN_ACCRUAL_REVERSAL_SOURCE, GRN_REVERSALS_COLLECTION } from '@/lib/api/grn-reversal-constants';
import type { JournalDetail } from '@/types/finance';
import type { JsonObject } from '@/types/json';

export { GRN_REVERSALS_COLLECTION, GRN_ACCRUAL_REVERSAL_SOURCE };

export type GrnReversalStatus = 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED' | 'CANCELLED';

export type GrnReversalActor = { userId: string; userName?: string; role?: string; isMaster?: boolean };

export type GrnReversalLine = {
  productId: string;
  productKode?: string;
  productNama?: string;
  warehouseKode: string;
  lotNo: string;
  qty: number;
  satuan?: string;
};

export type GrnReversalDoc = {
  id: string;
  tenantId: string;
  noReversal: string;
  sourceType: 'GRN';
  grnId: string;
  noGRN?: string;
  noDO?: string;
  noPO?: string;
  vendorTenantId?: string;
  reason: string;
  status: GrnReversalStatus;
  active?: true;
  lines: GrnReversalLine[];
  requestedBy: { userId: string; userName?: string; role?: string };
  requestedAt: Date;
  approvedBy?: { userId: string; userName?: string; role?: string };
  postedAt?: Date;
  rejectedBy?: { userId: string; userName?: string; role?: string };
  rejectedAt?: Date;
  rejectReason?: string;
  cancelledAt?: Date;
  journalId?: string;
  createdAt: Date;
  updatedAt: Date;
};

type Fail = { ok: false; error: string; status: number };

class ReversalAbort extends Error {
  constructor(readonly result: Fail) {
    super(result.error);
  }
}

function abort(error: string, status = 400): never {
  throw new ReversalAbort({ ok: false, error, status });
}

function actorStamp(a: GrnReversalActor) {
  return { userId: a.userId, userName: a.userName || '', role: a.role || '' };
}

function grnLabel(grn: JsonObject) {
  return String(grn.noGRN || grn.id || '');
}

function isOwnRequest(actor: GrnReversalActor, doc: Pick<GrnReversalDoc, 'requestedBy'>) {
  return !!doc.requestedBy?.userId && doc.requestedBy.userId === actor.userId;
}


/** Maker-checker ketat: pengaju tidak boleh menyetujui sendiri apa pun rolenya; MASTER dikecualikan (diaudit). */
export function grnReversalSelfApproveBlocked(actor: GrnReversalActor, doc: Pick<GrnReversalDoc, 'requestedBy'>): string | null {
  if (!isOwnRequest(actor, doc) || actor.isMaster) return null;
  return 'Pengaju pembalik tidak boleh menyetujui sendiri — minta penyetuju lain';
}

/** Tagihan vendor terkait GRN: yang masih aktif (belum ditolak) dan apakah ada tagihan sama sekali. */
async function findGrnHutang(db: Db, tenantId: string, grn: JsonObject, session?: ClientSession) {
  const or: Record<string, unknown>[] = [{ grnId: String(grn.id) }];
  if (grn.hutangId) or.push({ id: String(grn.hutangId) });
  if (grn.noGRN) or.push({ noGRN: String(grn.noGRN) });
  if (grn.noDO) {
    const byDo: Record<string, unknown> = { noDO: String(grn.noDO) };
    if (grn.vendorTenantId) byDo.vendorTenantId = String(grn.vendorTenantId);
    or.push(byDo);
  }
  const rows = await db.collection('hutang')
    .find({ $and: [tenantIdMatchFilter(tenantId), { $or: or }] }, { projection: { id: 1, noHutang: 1, noInvoice: 1, status: 1, approvalStatus: 1 }, ...txOpts(session) })
    .toArray();
  return {
    active: rows.find((h) => String(h.approvalStatus || h.status || '') !== 'REJECTED') || null,
    any: rows.length > 0,
  };
}

export type ReversibleResult = { ok: true; groups: GrnReversalLotGroup[] } | Fail;

/**
 * Syarat GRN bisa dibalik penuh. Dipanggil saat pengajuan dan diulang di dalam transaksi persetujuan.
 * `reversalId` = pengajuan yang sedang diproses (boleh memegang reversalPendingId GRN).
 */
export async function checkGrnReversible(
  db: Db,
  tenantId: string,
  grn: JsonObject | null,
  opts: { reversalId?: string; session?: ClientSession } = {},
): Promise<ReversibleResult> {
  const { session } = opts;
  if (!grn) return { ok: false, error: 'GRN tidak ditemukan', status: 404 };
  const label = grnLabel(grn);
  if (String(grn.status) === 'REVERSED') return { ok: false, error: `GRN ${label} sudah dibalik`, status: 409 };
  if (String(grn.status) !== 'POSTED') {
    return { ok: false, error: `Hanya GRN berstatus POSTED yang bisa dibalik (status ${label}: ${grn.status || '—'})`, status: 400 };
  }
  const pending = String(grn.reversalPendingId || '');
  if (pending && pending !== opts.reversalId) {
    return { ok: false, error: `GRN ${label} sudah punya pengajuan pembalik ${grn.reversalPendingNo || ''} yang menunggu persetujuan`.trim(), status: 409 };
  }
  if (String(grn.invoiceSyncStatus || '') === 'SYNCING') {
    return { ok: false, error: 'Faktur GRN ini sedang dibuat di sales.app — tunggu selesai, lalu tolak tagihannya di menu Hutang', status: 409 };
  }

  const hutangs = await findGrnHutang(db, tenantId, grn, session);
  const hutang = hutangs.active;
  if (hutang) {
    return {
      ok: false,
      error: `Tagihan ${hutang.noInvoice || hutang.noHutang || ''} masih aktif. Tolak tagihan di menu Hutang dulu; tagihan yang sudah disetujui atau dibayar diselesaikan lewat Retur Vendor + CN.`.replace(/\s+/g, ' '),
      status: 409,
    };
  }
  if (!hutangs.any && String(grn.vendorInvoiceId || grn.noInvoice || '').trim()) {
    return {
      ok: false,
      error: 'GRN ini sudah punya faktur vendor tetapi tagihannya belum masuk menu Hutang. Sinkronkan tagihan, tolak di menu Hutang, lalu ajukan pembalik lagi.',
      status: 409,
    };
  }

  const rtv = await db.collection('vendor_returns').findOne(
    { ...tenantIdMatchFilter(tenantId), grnId: String(grn.id) },
    { projection: { noReturn: 1, status: 1 }, ...txOpts(session) },
  );
  if (rtv) {
    return {
      ok: false,
      error: `GRN ini sudah punya retur vendor ${rtv.noReturn || ''} (${rtv.status}). Barang yang sudah diretur tidak bisa dibalik lewat GRN.`.replace(/\s+/g, ' '),
      status: 409,
    };
  }

  if (grn.noPO) {
    const po = await db.collection('customer_purchase_orders').findOne(
      { ...tenantIdMatchFilter(tenantId), noPO: String(grn.noPO) },
      { projection: { appliedReceiveGrnIds: 1 }, ...txOpts(session) },
    );
    const applied = Array.isArray(po?.appliedReceiveGrnIds) ? po!.appliedReceiveGrnIds.map(String) : [];
    if (po && !applied.includes(String(grn.id))) {
      return {
        ok: false,
        error: `Qty diterima PO ${grn.noPO} untuk GRN ini tidak tercatat per GRN (data lama), jadi PO tidak bisa dikoreksi otomatis. Koreksi lewat Penyesuaian stok.`,
        status: 409,
      };
    }
  }

  const groups = await loadGrnReversalLotGroups(db, tenantId, grn, session);
  if (!groups.ok) return { ok: false, error: groups.error, status: 409 };
  return { ok: true, groups: groups.groups };
}

function groupsToLines(groups: GrnReversalLotGroup[]): GrnReversalLine[] {
  return groups.map((g) => ({
    productId: g.productId,
    productKode: g.productKode,
    productNama: g.productNama,
    warehouseKode: g.warehouseKode,
    lotNo: g.lotNo,
    qty: g.qty,
    satuan: g.satuan,
  }));
}

function isDuplicateKey(e: unknown) {
  return !!e && typeof e === 'object' && (e as { code?: number }).code === 11000;
}

export async function requestGrnReversal(
  db: Db,
  input: { tenantId: string; grnId: string; reason: unknown; actor: GrnReversalActor },
): Promise<{ ok: true; reversal: GrnReversalDoc } | Fail> {
  const tid = input.tenantId;
  const reason = String(input.reason ?? '').trim().slice(0, 500);
  if (reason.length < 3) return { ok: false, error: 'Alasan pembalik wajib diisi (min. 3 karakter)', status: 400 };
  const grnId = String(input.grnId || '').trim();
  if (!grnId) return { ok: false, error: 'grnId wajib', status: 400 };
  try {
    return await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const grn = await txDb.collection('goods_receipts').findOne({ ...tenantIdMatchFilter(tid), id: grnId }, txOpts(session)) as JsonObject | null;
      const check = await checkGrnReversible(txDb, tid, grn, { session });
      if (!check.ok) throw new ReversalAbort(check);
      if (!check.groups.length) abort('GRN ini tidak punya qty diterima untuk dibalik');

      const now = new Date();
      const noReversal = await nextDocNumber(txDb, tid, 'RVS', 'RVS', session);
      const doc: GrnReversalDoc = {
        id: uuidv4(),
        tenantId: tid,
        noReversal,
        sourceType: 'GRN',
        grnId,
        noGRN: grn!.noGRN ? String(grn!.noGRN) : undefined,
        noDO: grn!.noDO ? String(grn!.noDO) : undefined,
        noPO: grn!.noPO ? String(grn!.noPO) : undefined,
        vendorTenantId: grn!.vendorTenantId ? String(grn!.vendorTenantId) : undefined,
        reason,
        status: 'PENDING_APPROVAL',
        active: true,
        lines: groupsToLines(check.groups),
        requestedBy: actorStamp(input.actor),
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await txDb.collection(GRN_REVERSALS_COLLECTION).insertOne({ ...doc }, txOpts(session));
      const claimed = await txDb.collection('goods_receipts').updateOne(
        { ...tenantIdMatchFilter(tid), id: grnId, status: 'POSTED', reversalPendingId: { $exists: false } },
        { $set: { reversalPendingId: doc.id, reversalPendingNo: noReversal, updatedAt: now } },
        txOpts(session),
      );
      if (!claimed.matchedCount) abort('GRN berubah bersamaan atau sudah punya pengajuan pembalik — muat ulang', 409);
      await writeAuditLog(txDb, {
        tenantId: tid,
        action: 'GRN_REVERSAL_REQUESTED',
        entityType: 'goods_receipt',
        entityId: grnId,
        summary: `${noReversal}: ajukan pembalik GRN ${grnLabel(grn!)} — ${reason}`,
        userId: input.actor.userId,
        userName: input.actor.userName,
        metadata: { reversalId: doc.id, noReversal, reason, lines: doc.lines },
      }, session);
      return { ok: true as const, reversal: doc };
    });
  } catch (e) {
    if (e instanceof ReversalAbort) return e.result;
    if (isDuplicateKey(e)) return { ok: false, error: 'GRN ini sudah punya pengajuan pembalik aktif', status: 409 };
    throw e;
  }
}

async function loadReversal(db: Db, tenantId: string, id: string, session?: ClientSession) {
  return db.collection(GRN_REVERSALS_COLLECTION).findOne({ tenantId, id }, txOpts(session)) as Promise<GrnReversalDoc | null>;
}

/** Koreksi harga beli rata-rata: keluarkan kontribusi GRN dari rata-rata tertimbang (sebelum stok keluar). */
async function buildReversePriceBulk(
  db: Db,
  session: ClientSession | undefined,
  tenantId: string,
  groups: GrnReversalLotGroup[],
  now: Date,
) {
  const byProduct = new Map<string, { qty: number; value: number; warehouses: Set<string> }>();
  for (const g of groups) {
    if (g.unitCost == null) continue;
    const acc = byProduct.get(g.productId) || { qty: 0, value: 0, warehouses: new Set<string>() };
    acc.qty += g.qty;
    acc.value += g.qty * g.unitCost;
    acc.warehouses.add(g.warehouseKode);
    byProduct.set(g.productId, acc);
  }
  const bulk: AnyBulkWriteOperation<Document>[] = [];
  for (const [productId, acc] of byProduct) {
    if (!(acc.qty > 0)) continue;
    const prod = await db.collection('products').findOne(productFilterById(tenantId, productId), txOpts(session));
    if (!prod) continue;
    const rows = await db.collection('stok_lokasi')
      .find({ tenantId, stokId: productId, lokasiKode: { $in: [...acc.warehouses] } }, txOpts(session))
      .project({ qty: 1 })
      .toArray();
    const lokasiQty = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    const oldBeli = parseInt(String(prod.hargaBeli || 0), 10);
    const newBeli = reverseWeightedAvgHargaBeli(lokasiQty, oldBeli, acc.qty, acc.value / acc.qty);
    if (newBeli === oldBeli) continue;
    bulk.push({
      updateOne: {
        filter: productFilterById(tenantId, productId),
        update: { $set: { hargaBeli: newBeli, ...buildJualPricesAfterBeliChange(oldBeli, newBeli, prod), updatedAt: now } },
      },
    });
  }
  return bulk;
}

async function reverseGrnAccrual(
  db: Db,
  session: ClientSession | undefined,
  input: { tenantId: string; grn: JsonObject; noReversal: string; userName: string; now: Date },
) {
  const accrual = await db.collection('jurnal').findOne(
    { tenantId: input.tenantId, sourceType: 'AUTO_GRN_ACCRUAL', sourceId: String(input.grn.id) },
    txOpts(session),
  );
  const details = Array.isArray(accrual?.details) ? accrual!.details as JournalDetail[] : [];
  if (!details.length) return null;
  const journal = await createJournalIfNotExists(db, {
    tanggal: input.now,
    keterangan: `Pembalik GRN ${grnLabel(input.grn)} (${input.noReversal})`,
    sourceType: GRN_ACCRUAL_REVERSAL_SOURCE,
    sourceId: String(input.grn.id),
    userName: input.userName,
    tenantId: input.tenantId,
    details: details.map((d) => ({
      ...d,
      debet: d.kredit || 0,
      kredit: d.debet || 0,
      keterangan: `Pembalik ${input.noReversal}: ${d.keterangan || ''}`.trim(),
    })),
  }, session);
  return journal?.id || null;
}

export async function approveGrnReversal(
  db: Db,
  input: { tenantId: string; reversalId: string; actor: GrnReversalActor },
): Promise<{ ok: true; reversal: GrnReversalDoc; alreadyPosted?: boolean } | Fail> {
  const tid = input.tenantId;
  try {
    const result = await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const rev = await loadReversal(txDb, tid, input.reversalId, session);
      if (!rev) abort('Pengajuan pembalik tidak ditemukan', 404);
      if (rev.status === 'POSTED') return { ok: true as const, reversal: rev, alreadyPosted: true };
      if (rev.status !== 'PENDING_APPROVAL') abort(`Pengajuan pembalik sudah ${rev.status}`, 409);
      const sod = grnReversalSelfApproveBlocked(input.actor, rev);
      if (sod) abort(sod, 403);

      const grn = await txDb.collection('goods_receipts').findOne({ ...tenantIdMatchFilter(tid), id: rev.grnId }, txOpts(session)) as JsonObject | null;
      if (grn && String(grn.reversalPendingId || '') !== rev.id && String(grn.status) === 'POSTED') {
        abort('GRN tidak lagi terkait pengajuan ini — muat ulang', 409);
      }
      const check = await checkGrnReversible(txDb, tid, grn, { reversalId: rev.id, session });
      if (!check.ok) throw new ReversalAbort(check);
      const groups = check.groups;
      if (!groups.length) abort('GRN ini tidak punya qty diterima untuk dibalik');

      const now = new Date();
      const approvedBy = actorStamp(input.actor);
      const claimed = await txDb.collection(GRN_REVERSALS_COLLECTION).updateOne(
        { tenantId: tid, id: rev.id, status: 'PENDING_APPROVAL' },
        { $set: { status: 'POSTED', approvedBy, postedAt: now, lines: groupsToLines(groups), updatedAt: now } },
        txOpts(session),
      );
      if (!claimed.matchedCount) abort('Pengajuan pembalik berubah bersamaan — muat ulang', 409);

      const grnLots = await txDb.collection(INGREDIENT_LOTS_COLLECTION)
        .find({ tenantId: tid, grnId: rev.grnId }, txOpts(session))
        .project({ id: 1 })
        .toArray();
      await releaseLotReservations(txDb, session, {
        tenantId: tid,
        lotIds: grnLots.map((l) => String(l.id)),
        reason: 'GRN_REVERSED',
      });

      const priceBulk = await buildReversePriceBulk(txDb, session, tid, groups, now);

      const stock = await postGrnReversalStock(txDb, session, {
        tenantId: tid,
        grn: grn!,
        reversalId: rev.id,
        noReversal: rev.noReversal,
        reason: rev.reason,
        groups,
        actor: { userId: input.actor.userId, userName: input.actor.userName, role: input.actor.role },
        postingDate: now,
      });
      if (!stock.ok) abort(stock.error, 409);

      if (priceBulk.length) {
        await txDb.collection('products').bulkWrite(priceBulk, { ordered: false, ...txOpts(session) });
      }

      if (grn!.noPO) {
        const synced = await syncCpoOnGrnReversed(txDb, { ...grn!, tenantId: tid }, session);
        if (synced.action === 'skipped' && synced.reason === 'concurrent_conflict') {
          abort('PO sedang diperbarui bersamaan — ulangi persetujuan', 409);
        }
      }

      const journalId = await reverseGrnAccrual(txDb, session, {
        tenantId: tid,
        grn: grn!,
        noReversal: rev.noReversal,
        userName: input.actor.userName || '',
        now,
      });
      if (journalId) {
        await txDb.collection(GRN_REVERSALS_COLLECTION).updateOne({ tenantId: tid, id: rev.id }, { $set: { journalId } }, txOpts(session));
      }

      const flipped = await txDb.collection('goods_receipts').updateOne(
        { ...tenantIdMatchFilter(tid), id: rev.grnId, status: 'POSTED', reversalPendingId: rev.id },
        {
          $set: {
            status: 'REVERSED',
            reversedBy: { reversalId: rev.id, noReversal: rev.noReversal },
            reversedAt: now,
            invoiceSyncStatus: 'SKIPPED',
            invoiceSyncError: 'grn_reversed',
            updatedAt: now,
          },
          $unset: { reversalPendingId: '', reversalPendingNo: '' },
        },
        txOpts(session),
      );
      if (!flipped.matchedCount) abort('GRN berubah bersamaan — muat ulang', 409);

      const reopenedWr = await reopenWrClosedByGrn(txDb, session, {
        tenantId: tid,
        grnId: rev.grnId,
        noGRN: grnLabel(grn!),
        noReversal: rev.noReversal,
        actor: { userId: input.actor.userId, userName: input.actor.userName },
      });

      if (isOwnRequest(input.actor, rev)) {
        await writeAuditLog(txDb, {
          tenantId: tid,
          action: 'GRN_REVERSAL_SELF_APPROVED',
          entityType: 'goods_receipt',
          entityId: rev.grnId,
          summary: `${rev.noReversal}: MASTER menyetujui pembalik GRN yang diajukannya sendiri (darurat)`,
          userId: input.actor.userId,
          userName: input.actor.userName,
          metadata: { reversalId: rev.id, requestedBy: rev.requestedBy },
        }, session);
      }
      await writeAuditLog(txDb, {
        tenantId: tid,
        action: 'GRN_REVERSED',
        entityType: 'goods_receipt',
        entityId: rev.grnId,
        summary: `${rev.noReversal}: GRN ${grnLabel(grn!)} dibalik — ${rev.reason}`,
        userId: input.actor.userId,
        userName: input.actor.userName,
        metadata: {
          reversalId: rev.id,
          noReversal: rev.noReversal,
          requestedBy: rev.requestedBy,
          lines: groupsToLines(groups),
          lotIds: stock.lotIds,
          journalId,
          sourceType: GRN_REVERSAL_SOURCE,
          ...(reopenedWr ? { reopenedWrId: reopenedWr.wrId } : {}),
        },
      }, session);

      return {
        ok: true as const,
        reversal: { ...rev, status: 'POSTED' as const, approvedBy, postedAt: now, lines: groupsToLines(groups), ...(journalId ? { journalId } : {}) },
        reopenedWr,
      };
    });
    if (result.ok && 'reopenedWr' in result && result.reopenedWr?.assetId) {
      await syncAssetStatusFromOpenRequests(db, tid, result.reopenedWr.assetId).catch((e) => {
        logger.warn('grn_reversal_asset_sync_failed', { tenantId: tid, error: e instanceof Error ? e.message : String(e) });
      });
    }
    if (result.ok && 'reopenedWr' in result) {
      const { reopenedWr: _wr, ...rest } = result;
      void _wr;
      return rest;
    }
    return result;
  } catch (e) {
    if (e instanceof ReversalAbort) return e.result;
    throw e;
  }
}

async function closePendingReversal(
  db: Db,
  input: {
    tenantId: string;
    reversalId: string;
    actor: GrnReversalActor;
    next: 'REJECTED' | 'CANCELLED';
    reason?: string;
  },
): Promise<{ ok: true; reversal: GrnReversalDoc } | Fail> {
  const tid = input.tenantId;
  try {
    return await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const rev = await loadReversal(txDb, tid, input.reversalId, session);
      if (!rev) abort('Pengajuan pembalik tidak ditemukan', 404);
      if (rev.status !== 'PENDING_APPROVAL') abort(`Pengajuan pembalik sudah ${rev.status}`, 409);
      const now = new Date();
      const stamp = actorStamp(input.actor);
      const patch: Record<string, unknown> = input.next === 'REJECTED'
        ? { status: 'REJECTED', rejectedBy: stamp, rejectedAt: now, rejectReason: input.reason, updatedAt: now }
        : { status: 'CANCELLED', cancelledAt: now, updatedAt: now };
      const res = await txDb.collection(GRN_REVERSALS_COLLECTION).updateOne(
        { tenantId: tid, id: rev.id, status: 'PENDING_APPROVAL' },
        { $set: patch, $unset: { active: '' } },
        txOpts(session),
      );
      if (!res.matchedCount) abort('Pengajuan pembalik berubah bersamaan — muat ulang', 409);
      await txDb.collection('goods_receipts').updateOne(
        { ...tenantIdMatchFilter(tid), id: rev.grnId, reversalPendingId: rev.id },
        { $unset: { reversalPendingId: '', reversalPendingNo: '' }, $set: { updatedAt: now } },
        txOpts(session),
      );
      await writeAuditLog(txDb, {
        tenantId: tid,
        action: input.next === 'REJECTED' ? 'GRN_REVERSAL_REJECTED' : 'GRN_REVERSAL_CANCELLED',
        entityType: 'goods_receipt',
        entityId: rev.grnId,
        summary: `${rev.noReversal}: pembalik GRN ${rev.noGRN || rev.grnId} ${input.next === 'REJECTED' ? `ditolak — ${input.reason}` : 'dibatalkan'}`,
        userId: input.actor.userId,
        userName: input.actor.userName,
        metadata: { reversalId: rev.id, noReversal: rev.noReversal, ...(input.reason ? { reason: input.reason } : {}) },
      }, session);
      const { active: _active, ...rest } = rev;
      void _active;
      return { ok: true as const, reversal: { ...rest, ...patch } as GrnReversalDoc };
    });
  } catch (e) {
    if (e instanceof ReversalAbort) return e.result;
    throw e;
  }
}

export async function rejectGrnReversal(
  db: Db,
  input: { tenantId: string; reversalId: string; reason: unknown; actor: GrnReversalActor },
) {
  const reason = String(input.reason ?? '').trim().slice(0, 500);
  if (reason.length < 3) return { ok: false as const, error: 'Alasan penolakan wajib diisi (min. 3 karakter)', status: 400 };
  return closePendingReversal(db, { ...input, reason, next: 'REJECTED' });
}

/** Batal oleh pengaju (atau ADMIN/MASTER). */
export async function cancelGrnReversal(
  db: Db,
  input: { tenantId: string; reversalId: string; actor: GrnReversalActor },
) {
  const rev = await loadReversal(db, input.tenantId, input.reversalId);
  if (!rev) return { ok: false as const, error: 'Pengajuan pembalik tidak ditemukan', status: 404 };
  const role = String(input.actor.role || '');
  const privileged = input.actor.isMaster || role === 'ADMIN' || role === 'OWNER' || role === 'MASTER';
  if (!privileged && rev.requestedBy?.userId !== input.actor.userId) {
    return { ok: false as const, error: 'Hanya pengaju yang bisa membatalkan pengajuan pembalik', status: 403 };
  }
  return closePendingReversal(db, { ...input, next: 'CANCELLED' });
}
