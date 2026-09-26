// Fase 5c — dokumen pembalik stok (RVS) untuk RL, PBL berposting stok, penyesuaian, dan transfer.
// Ajukan → setujui (maker-checker ketat) → kartu lawan diposting hari ini dengan harga kartu asli,
// lot / batch dikembalikan, jurnal dibalik, dokumen sumber berstatus REVERSED (PBL: CANCELLED).
// Pembalik selalu penuh satu dokumen.

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { runInTransactionOnDb, txOpts } from '@/lib/api/transaction';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { writeAuditLog } from '@/lib/api/audit-log';
import { createJournalIfNotExists } from '@/lib/api/journal';
import { buildPenyesuaianJournalLines } from '@/lib/api/journal-lines';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { idInTenant } from '@/lib/api/doc-filter';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { selfApprovalState } from '@/lib/api/stock-adjustment';
import {
  CONSUMPTION_JOURNAL_SOURCE,
  buildConsumptionJournalLines,
  postedLinesValue,
} from '@/lib/api/stock-cost-journal';
import { MAINTENANCE_REQUESTS_COLLECTION } from '@/lib/maintenance/constants';
import { parseLokasiKode } from '@/lib/api/stok-lokasi';
import { postStockMovements, type PostedStockLine, type StockMovementLine } from '@/lib/stock-ledger/post-stock-movements';
import { roundStockQty } from '@/lib/stock-ledger/precision';
import { restoreBatchesFromAllocations } from '@/lib/food-production/fefo-consume';
import { relocateBatchesFefo } from '@/lib/food-production/transfer-fefo';
import { syncBatchesOnVariance } from '@/lib/food-production/cycle-count-fefo';
import type { FefoAllocation } from '@/lib/food-production/fefo-allocate';
import { MATERIAL_ISSUES_COLLECTION } from '@/lib/food-production/material-issue';
import { PRODUCTION_PLANS_COLLECTION } from '@/lib/food-production/production-plan';
import type { AuthContext } from '@/types/auth';
import type { JournalDetail } from '@/types/finance';
import type { JsonObject } from '@/types/json';

export const STOCK_REVERSALS_COLLECTION = 'stock_reversals';
export const STOCK_REVERSAL_SOURCE = 'STOCK_REVERSAL';
export const STOCK_REVERSAL_JOURNAL_SOURCE = {
  CONSUMPTION: 'AUTO_RVS_CONSUMPTION',
  PENYESUAIAN: 'AUTO_RVS_PENYESUAIAN',
} as const;

export const STOCK_REVERSAL_SOURCE_TYPES = ['RELEASE', 'FP_ISSUE', 'PENYESUAIAN', 'TRANSFER'] as const;
export type StockReversalSourceType = (typeof STOCK_REVERSAL_SOURCE_TYPES)[number];

export type StockReversalStatus = 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED' | 'CANCELLED';

type ActorStamp = { userId: string; userName: string; role: string };

export type StockReversalLine = {
  lineRef: string;
  productId: string;
  productKode?: string;
  productNama?: string;
  warehouseKode: string;
  /** Qty lawan (satuan dasar): positif = stok kembali masuk, negatif = stok keluar lagi. */
  deltaQtyBase: number;
  unitCost: number;
  satuan?: string;
};

export type StockReversalDoc = {
  id: string;
  tenantId: string;
  noReversal: string;
  sourceType: StockReversalSourceType;
  sourceId: string;
  sourceNo: string;
  reason: string;
  status: StockReversalStatus;
  active?: true;
  lines: StockReversalLine[];
  requestedBy: ActorStamp;
  requestedAt: Date;
  approvedBy?: ActorStamp;
  postedAt?: Date;
  selfApprovedByMaster?: boolean;
  rejectedBy?: ActorStamp;
  rejectedAt?: Date;
  rejectReason?: string;
  cancelledBy?: ActorStamp;
  cancelledAt?: Date;
  journalIds?: string[];
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

function isDuplicateKey(e: unknown) {
  return !!e && typeof e === 'object' && (e as { code?: number }).code === 11000;
}

export function reversalActor(auth: AuthContext | null | undefined): ActorStamp {
  return {
    userId: String(auth?.userId || ''),
    userName: String(auth?.name || auth?.email || ''),
    role: String(auth?.role || ''),
  };
}

type SourceSpec = {
  collection: string;
  noField: string;
  label: string;
  /** Status dokumen sumber setelah dibalik. */
  reversedStatus: string;
  eligible: (doc: JsonObject) => string | null;
};

export const STOCK_REVERSAL_SOURCES: Record<StockReversalSourceType, SourceSpec> = {
  RELEASE: {
    collection: 'inventory_releases',
    noField: 'noRelease',
    label: 'Release operasional',
    reversedStatus: 'REVERSED',
    eligible: (d) => (String(d.status || '') === 'POSTED' ? null : 'Hanya RL berstatus POSTED yang bisa dibalik'),
  },
  FP_ISSUE: {
    collection: MATERIAL_ISSUES_COLLECTION,
    noField: 'noDokumen',
    label: 'Pengambilan bahan',
    // CANCELLED: status PBL memakai FpDocStatus; rencana bisa membuat PBL baru setelah dibalik.
    reversedStatus: 'CANCELLED',
    eligible: (d) => {
      if (String(d.stockMode || '') === 'REFERENCE' || !d.stockPostedAt) {
        return 'PBL acuan tidak memotong stok — tidak ada yang perlu dibalik';
      }
      return String(d.status || '') === 'COMPLETED' ? null : 'Hanya PBL berstatus COMPLETED yang bisa dibalik';
    },
  },
  PENYESUAIAN: {
    collection: 'penyesuaian_stok',
    noField: 'noPenyesuaian',
    label: 'Penyesuaian stok',
    reversedStatus: 'REVERSED',
    eligible: (d) => {
      if (d.source) return 'Penyesuaian otomatis sistem tidak bisa dibalik lewat RVS';
      const status = String(d.status || '');
      return !status || status === 'POSTED' ? null : 'Hanya penyesuaian berstatus POSTED yang bisa dibalik';
    },
  },
  TRANSFER: {
    collection: 'transfer_stok',
    noField: 'noTransfer',
    label: 'Transfer stok',
    reversedStatus: 'REVERSED',
    eligible: (d) => (d.status && String(d.status) !== 'POSTED' ? `Transfer berstatus ${String(d.status)}` : null),
  },
};

export function isStockReversalSourceType(v: unknown): v is StockReversalSourceType {
  return typeof v === 'string' && (STOCK_REVERSAL_SOURCE_TYPES as readonly string[]).includes(v);
}

type KartuRow = {
  id: string;
  stokId: string;
  lokasiKode: string;
  lineRef: string;
  masuk?: number;
  keluar?: number;
  hargaSatuan?: number;
  satuan?: string;
  ingredientLotAllocations?: FefoAllocation[];
  fefoAllocations?: FefoAllocation[];
};

type PlannedLine = StockReversalLine & { kartu: KartuRow };

export type StockReversalCheck =
  | { ok: true; doc: JsonObject; lines: PlannedLine[] }
  | Fail;

/**
 * Syarat dokumen bisa dibalik penuh. Dipanggil saat pengajuan dan diulang di dalam transaksi persetujuan.
 * `reversalId` = pengajuan yang sedang diproses (boleh memegang reversalPendingId sumber).
 */
export async function checkStockReversible(
  db: Db,
  tenantId: string,
  sourceType: StockReversalSourceType,
  sourceId: string,
  opts: { reversalId?: string; session?: ClientSession } = {},
): Promise<StockReversalCheck> {
  const spec = STOCK_REVERSAL_SOURCES[sourceType];
  const session = opts.session;
  const doc = await db.collection(spec.collection).findOne(idInTenant(sourceId, tenantId), txOpts(session)) as JsonObject | null;
  if (!doc) return { ok: false, error: `${spec.label} tidak ditemukan`, status: 404 };
  if (doc.reversedBy) return { ok: false, error: `${spec.label} ini sudah dibalik`, status: 409 };
  const pending = String(doc.reversalPendingId || '');
  if (pending && pending !== opts.reversalId) {
    return { ok: false, error: `${spec.label} ini sudah punya pengajuan pembalik ${String(doc.reversalPendingNo || '')}`.trim(), status: 409 };
  }
  const notEligible = spec.eligible(doc);
  if (notEligible) return { ok: false, error: notEligible, status: 400 };

  if ((sourceType === 'RELEASE' || sourceType === 'FP_ISSUE') && doc.productionPlanId) {
    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      idInTenant(String(doc.productionPlanId), tenantId),
      { projection: { status: 1, noDokumen: 1 }, ...txOpts(session) },
    );
    if (plan && String(plan.status) === 'COMPLETED') {
      return {
        ok: false,
        error: `Rencana produksi ${String(plan.noDokumen || doc.productionPlanNo || '')} sudah selesai — HPP-nya final, pembalik ditolak`.replace('  ', ' '),
        status: 400,
      };
    }
  }

  const rows = await db.collection('stok_kartu')
    .find({ tenantId, sourceType, sourceId }, txOpts(session))
    .project<KartuRow>({
      id: 1, stokId: 1, lokasiKode: 1, lineRef: 1, masuk: 1, keluar: 1, hargaSatuan: 1, satuan: 1,
      ingredientLotAllocations: 1, fefoAllocations: 1,
    })
    .sort({ lineRef: 1 })
    .toArray();
  const moved = rows.filter((r) => roundStockQty((Number(r.keluar) || 0) - (Number(r.masuk) || 0)) !== 0);
  if (!moved.length) return { ok: false, error: `${spec.label} ini tidak punya mutasi kartu stok untuk dibalik`, status: 400 };

  const ids = [...new Set(moved.map((r) => String(r.stokId)))];
  const products = await db.collection('products')
    .find({ ...tenantIdMatchFilter(tenantId), id: { $in: ids } }, txOpts(session))
    .project<{ id: string; kode?: string; nama?: string; satuan?: string; mergedInto?: string | null; deletedAt?: Date | null }>({
      id: 1, kode: 1, nama: 1, satuan: 1, mergedInto: 1, deletedAt: 1,
    })
    .toArray();
  const byId = new Map(products.map((p) => [String(p.id), p]));
  const lines: PlannedLine[] = [];
  for (const [idx, r] of moved.entries()) {
    const p = byId.get(String(r.stokId));
    const label = p?.kode || p?.nama || String(r.stokId);
    if (!p) return { ok: false, error: `Produk ${label} tidak ditemukan`, status: 400 };
    if (p.deletedAt) return { ok: false, error: `Produk ${label} sudah dihapus — pembalik ditolak`, status: 400 };
    if (p.mergedInto) return { ok: false, error: `Produk ${label} sudah digabung ke item lain — pembalik ditolak`, status: 400 };
    lines.push({
      // Kartu lama tanpa lineRef: urutan baris tetap unik di dalam satu pembalik.
      lineRef: r.lineRef ? String(r.lineRef) : `legacy:${idx + 1}`,
      productId: String(r.stokId),
      productKode: p.kode,
      productNama: p.nama,
      warehouseKode: String(r.lokasiKode),
      deltaQtyBase: roundStockQty((Number(r.keluar) || 0) - (Number(r.masuk) || 0)),
      unitCost: Number(r.hargaSatuan) || 0,
      satuan: r.satuan || p.satuan,
      kartu: r,
    });
  }
  return { ok: true, doc, lines };
}

function publicLines(lines: PlannedLine[]): StockReversalLine[] {
  return lines.map(({ kartu: _k, ...l }) => {
    void _k;
    return l;
  });
}

function sourceNo(spec: SourceSpec, doc: JsonObject) {
  return String(doc[spec.noField] || doc.id || '');
}

export async function requestStockReversal(
  db: Db,
  input: { tenantId: string; sourceType: unknown; sourceId: unknown; reason: unknown; actor: ActorStamp },
): Promise<{ ok: true; reversal: StockReversalDoc } | Fail> {
  const tid = input.tenantId;
  if (!isStockReversalSourceType(input.sourceType)) return { ok: false, error: 'Jenis dokumen sumber tidak didukung', status: 400 };
  const sourceType = input.sourceType;
  const sourceId = String(input.sourceId || '').trim();
  if (!sourceId) return { ok: false, error: 'sourceId wajib', status: 400 };
  const reason = String(input.reason ?? '').trim().slice(0, 500);
  if (reason.length < 3) return { ok: false, error: 'Alasan pembalik wajib diisi (min. 3 karakter)', status: 400 };
  if (!input.actor.userId) return { ok: false, error: 'Unauthorized', status: 401 };
  const spec = STOCK_REVERSAL_SOURCES[sourceType];
  try {
    return await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const check = await checkStockReversible(txDb, tid, sourceType, sourceId, { session });
      if (!check.ok) throw new ReversalAbort(check);
      const now = new Date();
      const noReversal = await nextDocNumber(txDb, tid, 'RVS', 'RVS', session);
      const no = sourceNo(spec, check.doc);
      const doc: StockReversalDoc = {
        id: uuidv4(),
        tenantId: tid,
        noReversal,
        sourceType,
        sourceId,
        sourceNo: no,
        reason,
        status: 'PENDING_APPROVAL',
        active: true,
        lines: publicLines(check.lines),
        requestedBy: input.actor,
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await txDb.collection(STOCK_REVERSALS_COLLECTION).insertOne({ ...doc }, txOpts(session));
      const claimed = await txDb.collection(spec.collection).updateOne(
        { ...idInTenant(sourceId, tid), reversalPendingId: { $exists: false }, reversedBy: { $exists: false } },
        { $set: { reversalPendingId: doc.id, reversalPendingNo: noReversal } },
        txOpts(session),
      );
      if (!claimed.matchedCount) abort(`${spec.label} berubah bersamaan atau sudah punya pengajuan pembalik — muat ulang`, 409);
      await writeAuditLog(txDb, {
        tenantId: tid,
        action: 'STOCK_REVERSAL_REQUESTED',
        entityType: spec.collection,
        entityId: sourceId,
        summary: `${noReversal}: ajukan pembalik ${spec.label} ${no} — ${reason}`,
        userId: input.actor.userId,
        userName: input.actor.userName,
        metadata: { reversalId: doc.id, noReversal, sourceType, reason, lines: doc.lines },
      }, session);
      return { ok: true as const, reversal: doc };
    });
  } catch (e) {
    if (e instanceof ReversalAbort) return e.result;
    if (isDuplicateKey(e)) return { ok: false, error: `${spec.label} ini sudah punya pengajuan pembalik aktif`, status: 409 };
    throw e;
  }
}

async function loadReversal(db: Db, tenantId: string, id: string, session?: ClientSession) {
  return db.collection(STOCK_REVERSALS_COLLECTION).findOne({ tenantId, id }, txOpts(session)) as Promise<StockReversalDoc | null>;
}

/** Baris kartu lawan beserta kebijakan lot yang mengembalikan lot bahan ke posisi semula. */
function movementLines(
  sourceType: StockReversalSourceType,
  doc: JsonObject,
  lines: PlannedLine[],
  reversal: { id: string; noReversal: string },
): StockMovementLine[] {
  const asalKode = parseLokasiKode(String(doc.lokasiAsal || ''));
  return lines.map((l) => {
    const base: StockMovementLine = {
      lineRef: l.lineRef,
      productId: l.productId,
      warehouseKode: l.warehouseKode,
      deltaQtyBase: l.deltaQtyBase,
      unitCost: l.unitCost,
      satuan: l.satuan,
      keterangan: `Pembalik ${reversal.noReversal} baris ${l.lineRef}`,
      kartuExtra: { reversalOfSourceType: sourceType, reversalOfSourceId: String(doc.id || ''), reversalOfKartuId: l.kartu.id },
    };
    if (sourceType === 'PENYESUAIAN') return { ...base, lotPolicy: { mode: 'VARIANCE' } };
    if (sourceType === 'TRANSFER') {
      return l.deltaQtyBase < 0
        ? { ...base, lotPolicy: { mode: 'RELOCATE', toWarehouseKode: asalKode, allowExpired: true } }
        : base;
    }
    if (l.deltaQtyBase > 0) {
      const restores = Array.isArray(l.kartu.ingredientLotAllocations) ? l.kartu.ingredientLotAllocations : [];
      return restores.length ? { ...base, lotPolicy: { mode: 'RESTORE', restores } } : base;
    }
    return { ...base, lotPolicy: { mode: 'FEFO_CONSUME', allowExpired: true } };
  });
}

/** Batch barang jadi mengikuti stok: RL dikembalikan persis, transfer direlokasi balik, penyesuaian disinkron. */
async function reverseFoodBatches(
  db: Db,
  session: ClientSession | undefined,
  input: { tenantId: string; sourceType: StockReversalSourceType; doc: JsonObject; lines: PlannedLine[]; noReversal: string; now: Date },
) {
  const { tenantId, sourceType, doc, lines, noReversal, now } = input;
  if (sourceType === 'RELEASE') {
    for (const l of lines) {
      const restores = Array.isArray(l.kartu.fefoAllocations) ? l.kartu.fefoAllocations : [];
      if (!restores.length) continue;
      await restoreBatchesFromAllocations(db, { tenantId, stokId: l.productId, restores, asOf: now, noDokumen: noReversal }, session);
    }
    return;
  }
  if (sourceType === 'TRANSFER') {
    const relocated = Array.isArray(doc.fefoRelocate) ? doc.fefoRelocate as Array<Record<string, unknown>> : [];
    for (const r of relocated) {
      const qty = roundStockQty(Number(r.allocated) || 0);
      if (!(qty > 0)) continue;
      await relocateBatchesFefo(db, {
        tenantId,
        stokId: String(r.stokId),
        fromWarehouseKode: String(r.toWarehouseKode),
        toWarehouseKode: String(r.fromWarehouseKode),
        needQty: qty,
        asOf: now,
        allowExpired: true,
        noTransaksi: noReversal,
        transferId: String(doc.id || ''),
      }, session);
    }
    return;
  }
  if (sourceType === 'PENYESUAIAN') {
    for (const l of lines) {
      await syncBatchesOnVariance(db, {
        tenantId,
        stokId: l.productId,
        warehouseKode: l.warehouseKode,
        deltaQty: l.deltaQtyBase,
        asOf: now,
        noDokumen: noReversal,
      }, session);
    }
  }
}

function swapDetails(details: JournalDetail[], noReversal: string): JournalDetail[] {
  return details.map((d) => ({
    ...d,
    debet: d.kredit || 0,
    kredit: d.debet || 0,
    keterangan: `Pembalik ${noReversal}: ${d.keterangan || ''}`.trim(),
  }));
}

async function postReversalJournals(
  db: Db,
  session: ClientSession | undefined,
  input: { tenantId: string; rev: StockReversalDoc; posted: PostedStockLine[]; userName: string; now: Date },
): Promise<string[]> {
  const { tenantId, rev, posted, userName, now } = input;
  const costingV2 = await isTenantFeatureEnabled(db, tenantId, 'costingV2');
  const ids: string[] = [];
  const base = { tanggal: now, userName, tenantId };

  if (rev.sourceType === 'RELEASE' || rev.sourceType === 'FP_ISSUE') {
    const original = await db.collection('jurnal').findOne(
      { tenantId, sourceType: CONSUMPTION_JOURNAL_SOURCE[rev.sourceType], sourceId: rev.sourceId },
      { projection: { _id: 0, id: 1 }, ...txOpts(session) },
    );
    if (!costingV2 && !original) return ids;
    const consumption = buildConsumptionJournalLines({ noDoc: rev.sourceNo, amount: postedLinesValue(posted) });
    if (!consumption.length) return ids;
    const j = await createJournalIfNotExists(db, {
      ...base,
      keterangan: `Pembalik pemakaian bahan ${rev.sourceNo} (${rev.noReversal})`,
      sourceType: STOCK_REVERSAL_JOURNAL_SOURCE.CONSUMPTION,
      sourceId: rev.id,
      details: swapDetails(consumption, rev.noReversal),
    }, session);
    if (j?.id) ids.push(j.id);
    return ids;
  }

  if (rev.sourceType === 'PENYESUAIAN') {
    if (costingV2) {
      const byProduct = new Map<string, PostedStockLine[]>();
      for (const l of posted) byProduct.set(l.productId, [...(byProduct.get(l.productId) || []), l]);
      for (const [productId, pl] of byProduct) {
        const net = pl.reduce((s, l) => s + (l.costSource === 'NON_INVENTORY' ? 0 : l.deltaQtyBase * l.unitCost), 0);
        const details = buildPenyesuaianJournalLines({ noDoc: rev.noReversal, amount: net, increase: net > 0 });
        if (!details.length) continue;
        const j = await createJournalIfNotExists(db, {
          ...base,
          keterangan: `Pembalik penyesuaian ${rev.sourceNo} (${rev.noReversal})`,
          sourceType: STOCK_REVERSAL_JOURNAL_SOURCE.PENYESUAIAN,
          sourceId: `${rev.id}:${productId}`,
          details,
        }, session);
        if (j?.id) ids.push(j.id);
      }
      return ids;
    }
    const escaped = rev.sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const originals = await db.collection('jurnal')
      .find({ tenantId, sourceType: 'AUTO_PENYESUAIAN', sourceId: { $regex: `^${escaped}(:|$)` } }, txOpts(session))
      .toArray();
    for (const o of originals) {
      const details = Array.isArray(o.details) ? o.details as JournalDetail[] : [];
      if (!details.length) continue;
      const j = await createJournalIfNotExists(db, {
        ...base,
        keterangan: `Pembalik penyesuaian ${rev.sourceNo} (${rev.noReversal})`,
        sourceType: STOCK_REVERSAL_JOURNAL_SOURCE.PENYESUAIAN,
        sourceId: `${rev.id}:${String(o.id)}`,
        details: swapDetails(details, rev.noReversal),
      }, session);
      if (j?.id) ids.push(j.id);
    }
  }
  return ids;
}

/** RL yang menutup WR otomatis dibalik: WR dibuka lagi karena bahannya dianggap tidak pernah keluar. */
async function reopenWrClosedByRelease(
  db: Db,
  session: ClientSession | undefined,
  input: { tenantId: string; doc: JsonObject; noReversal: string; actor: ActorStamp; now: Date },
): Promise<{ wrId: string; assetId?: string } | null> {
  const wrId = String(input.doc.maintenanceRequestId || '');
  if (!wrId) return null;
  const wr = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).findOne(
    { tenantId: input.tenantId, id: wrId, autoClosedBy: 'RELEASE', status: 'CLOSED' },
    txOpts(session),
  );
  if (!wr) return null;
  const noRelease = String(input.doc.noRelease || input.doc.id || '');
  const res = await db.collection(MAINTENANCE_REQUESTS_COLLECTION).updateOne(
    { tenantId: input.tenantId, id: wrId, status: 'CLOSED', autoClosedBy: 'RELEASE' },
    {
      $set: { status: 'IN_PROGRESS', reopenedAt: input.now, reopenReason: `RL ${noRelease} dibalik (${input.noReversal})`, updatedAt: input.now },
      $unset: { closedAt: '', autoClosedAt: '', autoClosedBy: '', completedAt: '' },
    },
    txOpts(session),
  );
  if (!res.modifiedCount) return null;
  await writeAuditLog(db, {
    tenantId: input.tenantId,
    action: 'MAINTENANCE_WR_REOPENED',
    entityType: 'maintenance_request',
    entityId: wrId,
    summary: `${String(wr.noWR || wrId)} dibuka lagi — RL ${noRelease} dibalik (${input.noReversal})`,
    userId: input.actor.userId,
    userName: input.actor.userName || 'System',
    metadata: { releaseId: String(input.doc.id || ''), noReversal: input.noReversal },
  }, session);
  return { wrId, ...(wr.assetId ? { assetId: String(wr.assetId) } : {}) };
}

export type ApproveStockReversalResult =
  | { ok: true; reversal: StockReversalDoc; alreadyPosted?: boolean; reopenedWr?: { wrId: string; assetId?: string } | null }
  | Fail;

/**
 * `auth` = sesi asli (bukan scope acting) agar pengecualian MASTER dan identitas penyetuju tepat.
 */
export async function approveStockReversal(
  db: Db,
  input: { tenantId: string; reversalId: string; auth: AuthContext },
): Promise<ApproveStockReversalResult> {
  const tid = input.tenantId;
  const actor = reversalActor(input.auth);
  try {
    return await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const rev = await loadReversal(txDb, tid, input.reversalId, session);
      if (!rev) abort('Pengajuan pembalik tidak ditemukan', 404);
      if (rev.status === 'POSTED') return { ok: true as const, reversal: rev, alreadyPosted: true };
      if (rev.status !== 'PENDING_APPROVAL') abort(`Pengajuan pembalik sudah ${rev.status}`, 409);
      const self = selfApprovalState(input.auth, [rev.requestedBy]);
      if (self === 'blocked') abort('Pengaju pembalik tidak boleh menyetujui sendiri — minta penyetuju lain', 403);

      const spec = STOCK_REVERSAL_SOURCES[rev.sourceType];
      const check = await checkStockReversible(txDb, tid, rev.sourceType, rev.sourceId, { reversalId: rev.id, session });
      if (!check.ok) throw new ReversalAbort(check);
      if (String(check.doc.reversalPendingId || '') !== rev.id) abort(`${spec.label} tidak lagi terkait pengajuan ini — muat ulang`, 409);

      const now = new Date();
      const lines = publicLines(check.lines);
      const claimed = await txDb.collection(STOCK_REVERSALS_COLLECTION).updateOne(
        { tenantId: tid, id: rev.id, status: 'PENDING_APPROVAL' },
        {
          $set: {
            status: 'POSTED',
            approvedBy: actor,
            postedAt: now,
            lines,
            updatedAt: now,
            ...(self === 'master_override' ? { selfApprovedByMaster: true } : {}),
          },
        },
        txOpts(session),
      );
      if (!claimed.matchedCount) abort('Pengajuan pembalik berubah bersamaan — muat ulang', 409);

      const stock = await postStockMovements(txDb, session, {
        tenantId: tid,
        sourceType: STOCK_REVERSAL_SOURCE,
        sourceId: rev.id,
        noTransaksi: rev.noReversal,
        keterangan: `Pembalik ${spec.label} ${rev.sourceNo}: ${rev.reason}`,
        postingDate: now,
        actor,
        lines: movementLines(rev.sourceType, check.doc, check.lines, rev),
      });
      if (!stock.ok) abort(stock.error, 409);

      await reverseFoodBatches(txDb, session, {
        tenantId: tid,
        sourceType: rev.sourceType,
        doc: check.doc,
        lines: check.lines,
        noReversal: rev.noReversal,
        now,
      });

      const journalIds = await postReversalJournals(txDb, session, {
        tenantId: tid,
        rev,
        posted: stock.lines,
        userName: actor.userName,
        now,
      });
      if (journalIds.length) {
        await txDb.collection(STOCK_REVERSALS_COLLECTION).updateOne({ tenantId: tid, id: rev.id }, { $set: { journalIds } }, txOpts(session));
      }

      const previousStatus = check.doc.status ?? null;
      const flip: Record<string, unknown> = {
        $set: {
          status: spec.reversedStatus,
          previousStatus,
          reversedBy: { reversalId: rev.id, noReversal: rev.noReversal },
          reversedAt: now,
          updatedAt: now,
        },
        $unset: { reversalPendingId: '', reversalPendingNo: '' },
      };
      if (rev.sourceType === 'FP_ISSUE') {
        flip.$push = {
          history: {
            at: now,
            fromStatus: String(previousStatus || ''),
            toStatus: spec.reversedStatus,
            userId: actor.userId,
            userName: actor.userName,
            note: `Dibalik ${rev.noReversal}: ${rev.reason}`,
          },
        };
      }
      const flipped = await txDb.collection(spec.collection).updateOne(
        { ...idInTenant(rev.sourceId, tid), reversalPendingId: rev.id },
        flip,
        txOpts(session),
      );
      if (!flipped.matchedCount) abort(`${spec.label} berubah bersamaan — muat ulang`, 409);

      const reopenedWr = rev.sourceType === 'RELEASE'
        ? await reopenWrClosedByRelease(txDb, session, { tenantId: tid, doc: check.doc, noReversal: rev.noReversal, actor, now })
        : null;

      if (self === 'master_override') {
        await writeAuditLog(txDb, {
          tenantId: tid,
          action: 'STOCK_REVERSAL_SELF_APPROVED',
          entityType: STOCK_REVERSALS_COLLECTION,
          entityId: rev.id,
          summary: `${rev.noReversal}: MASTER menyetujui pembalik yang diajukannya sendiri (darurat)`,
          userId: actor.userId,
          userName: actor.userName,
          metadata: { sourceType: rev.sourceType, sourceId: rev.sourceId, requestedBy: rev.requestedBy },
        }, session);
      }
      await writeAuditLog(txDb, {
        tenantId: tid,
        action: 'STOCK_REVERSED',
        entityType: spec.collection,
        entityId: rev.sourceId,
        summary: `${rev.noReversal}: ${spec.label} ${rev.sourceNo} dibalik — ${rev.reason}`,
        userId: actor.userId,
        userName: actor.userName,
        metadata: {
          reversalId: rev.id,
          noReversal: rev.noReversal,
          sourceType: rev.sourceType,
          requestedBy: rev.requestedBy,
          lines,
          journalIds,
          previousStatus,
          ...(reopenedWr ? { reopenedWrId: reopenedWr.wrId } : {}),
        },
      }, session);

      return {
        ok: true as const,
        reversal: {
          ...rev,
          status: 'POSTED' as const,
          approvedBy: actor,
          postedAt: now,
          lines,
          ...(journalIds.length ? { journalIds } : {}),
          ...(self === 'master_override' ? { selfApprovedByMaster: true } : {}),
        },
        reopenedWr,
      };
    });
  } catch (e) {
    if (e instanceof ReversalAbort) return e.result;
    throw e;
  }
}

async function closePendingReversal(
  db: Db,
  input: { tenantId: string; reversalId: string; actor: ActorStamp; next: 'REJECTED' | 'CANCELLED'; reason?: string },
): Promise<{ ok: true; reversal: StockReversalDoc } | Fail> {
  const tid = input.tenantId;
  try {
    return await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const rev = await loadReversal(txDb, tid, input.reversalId, session);
      if (!rev) abort('Pengajuan pembalik tidak ditemukan', 404);
      if (rev.status !== 'PENDING_APPROVAL') abort(`Pengajuan pembalik sudah ${rev.status}`, 409);
      const spec = STOCK_REVERSAL_SOURCES[rev.sourceType];
      const now = new Date();
      const patch: Record<string, unknown> = input.next === 'REJECTED'
        ? { status: 'REJECTED', rejectedBy: input.actor, rejectedAt: now, rejectReason: input.reason, updatedAt: now }
        : { status: 'CANCELLED', cancelledBy: input.actor, cancelledAt: now, updatedAt: now };
      const res = await txDb.collection(STOCK_REVERSALS_COLLECTION).updateOne(
        { tenantId: tid, id: rev.id, status: 'PENDING_APPROVAL' },
        { $set: patch, $unset: { active: '' } },
        txOpts(session),
      );
      if (!res.matchedCount) abort('Pengajuan pembalik berubah bersamaan — muat ulang', 409);
      await txDb.collection(spec.collection).updateOne(
        { ...idInTenant(rev.sourceId, tid), reversalPendingId: rev.id },
        { $unset: { reversalPendingId: '', reversalPendingNo: '' } },
        txOpts(session),
      );
      await writeAuditLog(txDb, {
        tenantId: tid,
        action: input.next === 'REJECTED' ? 'STOCK_REVERSAL_REJECTED' : 'STOCK_REVERSAL_CANCELLED',
        entityType: spec.collection,
        entityId: rev.sourceId,
        summary: `${rev.noReversal}: pembalik ${spec.label} ${rev.sourceNo} ${input.next === 'REJECTED' ? `ditolak — ${input.reason}` : 'dibatalkan'}`,
        userId: input.actor.userId,
        userName: input.actor.userName,
        metadata: { reversalId: rev.id, noReversal: rev.noReversal, ...(input.reason ? { reason: input.reason } : {}) },
      }, session);
      const { active: _active, ...rest } = rev;
      void _active;
      return { ok: true as const, reversal: { ...rest, ...patch } as StockReversalDoc };
    });
  } catch (e) {
    if (e instanceof ReversalAbort) return e.result;
    throw e;
  }
}

export async function rejectStockReversal(
  db: Db,
  input: { tenantId: string; reversalId: string; reason: unknown; actor: ActorStamp },
) {
  const reason = String(input.reason ?? '').trim().slice(0, 500);
  if (reason.length < 3) return { ok: false as const, error: 'Alasan penolakan wajib diisi (min. 3 karakter)', status: 400 };
  return closePendingReversal(db, { ...input, reason, next: 'REJECTED' });
}

/** Batal oleh pengaju atau role penyetuju. */
export async function cancelStockReversal(
  db: Db,
  input: { tenantId: string; reversalId: string; actor: ActorStamp; canApprove: boolean },
) {
  const rev = await loadReversal(db, input.tenantId, input.reversalId);
  if (!rev) return { ok: false as const, error: 'Pengajuan pembalik tidak ditemukan', status: 404 };
  if (!input.canApprove && rev.requestedBy?.userId !== input.actor.userId) {
    return { ok: false as const, error: 'Hanya pengaju atau penyetuju yang bisa membatalkan pengajuan pembalik', status: 403 };
  }
  return closePendingReversal(db, { tenantId: input.tenantId, reversalId: input.reversalId, actor: input.actor, next: 'CANCELLED' });
}
