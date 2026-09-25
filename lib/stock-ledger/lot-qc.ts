// Fase 3.2 — QC lot bahan: qty tertahan (karantina/ditolak), inspeksi (lolos/gagal/pecah lot),
// klaim tindak lanjut RTV. Tidak ada mutasi saldo: lot tertahan tetap stok fisik di gudang yang sama.

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { txOpts, runInTransactionOnDb } from '@/lib/api/transaction';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { writeAuditLog } from '@/lib/api/audit-log';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import {
  INGREDIENT_LOTS_COLLECTION,
  LOT_QC_HELD_STATUSES,
  effectiveIngredientQtyRemaining,
  effectiveLotQcStatus,
  type IngredientLotDoc,
  type LotQcStatus,
} from '@/lib/food-production/ingredient-lot';
import { qtyEq, qtyGt, roundStockQty } from '@/lib/stock-ledger/precision';
import { capActiveAllocationTo } from '@/lib/stock-ledger/plan-reservation';

export const LOT_INSPECTIONS_COLLECTION = 'lot_inspections';

/** Gudang yang suhunya wajib dicatat saat inspeksi (bahan basah / chiller). */
export const QC_TEMPERATURE_REQUIRED_WAREHOUSES = ['GBASAH'] as const;
export const QC_TEMPERATURE_MIN_C = -30;
export const QC_TEMPERATURE_MAX_C = 60;

export const LOT_INSPECTION_KONDISI = [
  'BAIK',
  'KEMASAN_RUSAK',
  'BUSUK_BERJAMUR',
  'SUHU_TIDAK_SESUAI',
  'TIDAK_SESUAI_SPEK',
  'LAINNYA',
] as const;
export type LotInspectionKondisi = (typeof LOT_INSPECTION_KONDISI)[number];

export type LotInspectionHasil = 'LOLOS' | 'DITOLAK' | 'SEBAGIAN';

export interface LotInspectionActor {
  userId: string;
  userName?: string;
  role?: string;
  isMaster?: boolean;
}

export interface LotInspectionDoc {
  id: string;
  tenantId: string;
  noInspeksi: string;
  lotId: string;
  lotNo: string;
  rejectedLotId?: string;
  rejectedLotNo?: string;
  grnId?: string;
  noGRN?: string;
  productId: string;
  productKode?: string;
  productNama?: string;
  warehouseKode: string;
  satuan?: string;
  qtyInspected: number;
  qtyPassed: number;
  qtyFailed: number;
  suhuC: number | null;
  kondisi: LotInspectionKondisi;
  hasil: LotInspectionHasil;
  alasanTolak?: string;
  catatan?: string;
  receivedByUserId?: string;
  inspectedBy: { userId: string; userName?: string; role?: string };
  inspectedAt: Date;
  createdAt: Date;
}

export type LotQcHeldInfo = {
  quarantine: number;
  rejected: number;
  byLotNo: Map<string, { qty: number; qcStatus: LotQcStatus }>;
};

export function lotQcPairKey(productId: string, lokasiKode: string): string {
  return `${productId}\u0000${lokasiKode}`;
}

export function lotQcHeldTotal(info: LotQcHeldInfo | undefined | null): number {
  return info ? roundStockQty(info.quarantine + info.rejected) : 0;
}

/** Qty karantina/ditolak per (produk, gudang) — dasar guard keluar & stok tersedia. */
export async function loadLotQcHeld(
  db: Db,
  tenantId: string,
  pairs: Array<{ productId: string; lokasiKode: string }>,
  session?: ClientSession,
): Promise<Map<string, LotQcHeldInfo>> {
  const out = new Map<string, LotQcHeldInfo>();
  const uniq = [...new Map(pairs.filter((p) => p.productId && p.lokasiKode)
    .map((p) => [lotQcPairKey(p.productId, p.lokasiKode), p])).values()];
  if (!uniq.length) return out;
  const rows = await db.collection(INGREDIENT_LOTS_COLLECTION)
    .find({
      tenantId: tenantId || 'default',
      status: { $in: ['ACTIVE', 'EXPIRED'] },
      qcStatus: { $in: [...LOT_QC_HELD_STATUSES] },
      $or: uniq.map((p) => ({ productId: p.productId, warehouseKode: p.lokasiKode })),
    }, txOpts(session))
    .project({ productId: 1, warehouseKode: 1, lotNo: 1, qty: 1, qtyRemaining: 1, status: 1, qcStatus: 1 })
    .toArray() as unknown as IngredientLotDoc[];
  for (const lot of rows) {
    const rem = effectiveIngredientQtyRemaining(lot);
    if (!(rem > 0)) continue;
    const key = lotQcPairKey(String(lot.productId), String(lot.warehouseKode));
    const info = out.get(key) || { quarantine: 0, rejected: 0, byLotNo: new Map() };
    const qc = effectiveLotQcStatus(lot);
    if (qc === 'QUARANTINE') info.quarantine = roundStockQty(info.quarantine + rem);
    else info.rejected = roundStockQty(info.rejected + rem);
    const no = String(lot.lotNo || '').trim();
    if (no) {
      const prev = info.byLotNo.get(no);
      info.byLotNo.set(no, { qty: roundStockQty((prev?.qty || 0) + rem), qcStatus: qc });
    }
    out.set(key, info);
  }
  return out;
}

/** Map productId → qty tertahan QC di satu gudang (untuk stok tersedia RL). */
export async function loadLotQcHeldQtyByProduct(
  db: Db,
  tenantId: string,
  productIds: string[],
  lokasiKode: string,
  session?: ClientSession,
): Promise<Map<string, number>> {
  const held = await loadLotQcHeld(db, tenantId, productIds.map((productId) => ({ productId, lokasiKode })), session);
  const out = new Map<string, number>();
  for (const id of productIds) {
    const total = lotQcHeldTotal(held.get(lotQcPairKey(id, lokasiKode)));
    if (total > 0) out.set(id, total);
  }
  return out;
}

function fmtQty(n: number): string {
  return String(roundStockQty(n));
}

/** "5 KG masih karantina QC, 1 KG ditolak QC" */
export function describeLotQcHeld(info: Pick<LotQcHeldInfo, 'quarantine' | 'rejected'>, satuan?: string): string {
  const s = satuan ? ` ${satuan}` : '';
  const parts: string[] = [];
  if (info.quarantine > 0) parts.push(`${fmtQty(info.quarantine)}${s} masih karantina QC`);
  if (info.rejected > 0) parts.push(`${fmtQty(info.rejected)}${s} ditolak QC (menunggu retur/pemusnahan)`);
  return parts.join(', ');
}

export function lotQcBlockedMessage(input: {
  label: string;
  lokasiKode: string;
  need: number;
  releasedAvailable: number;
  held: Pick<LotQcHeldInfo, 'quarantine' | 'rejected'>;
  satuan?: string;
}): string {
  const s = input.satuan ? ` ${input.satuan}` : '';
  return `${input.label}: ${describeLotQcHeld(input.held, input.satuan)} di ${input.lokasiKode} — `
    + `yang boleh keluar ${fmtQty(Math.max(0, input.releasedAvailable))}${s}, diminta ${fmtQty(input.need)}${s}. `
    + 'Selesaikan pemeriksaan di menu QC Penerimaan.';
}

// ---------------------------------------------------------------------------
// Inspeksi
// ---------------------------------------------------------------------------

export interface LotInspectionInput {
  tenantId: string;
  lotId: string;
  qtyPassed: unknown;
  qtyFailed: unknown;
  suhuC?: unknown;
  kondisi: unknown;
  alasanTolak?: unknown;
  catatan?: unknown;
  actor: LotInspectionActor;
}

export type NormalizedLotInspection = {
  qtyPassed: number;
  qtyFailed: number;
  suhuC: number | null;
  kondisi: LotInspectionKondisi;
  alasanTolak?: string;
  catatan?: string;
  hasil: LotInspectionHasil;
};

type InspectionError = { error: string; status: number };

function parseQty(raw: unknown, label: string): number | InspectionError {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} tidak valid`, status: 400 };
  return roundStockQty(n);
}

/** Pemeriksa ≠ penerima GRN, kecuali ADMIN/MASTER. */
export function lotInspectionSodError(actor: LotInspectionActor, receivedByUserId?: string | null): string | null {
  if (actor.isMaster || actor.role === 'ADMIN' || actor.role === 'MASTER' || actor.role === 'OWNER') return null;
  if (receivedByUserId && receivedByUserId === actor.userId) {
    return 'Pemeriksa QC tidak boleh penerima barang yang sama — minta SUPERVISOR lain atau ADMIN';
  }
  return null;
}

/** Validasi murni isian inspeksi terhadap lot (tanpa I/O). */
export function validateLotInspection(
  lot: Pick<IngredientLotDoc, 'qcStatus' | 'status' | 'qty' | 'qtyRemaining' | 'warehouseKode' | 'productNama' | 'productKode' | 'satuan'>,
  input: Omit<LotInspectionInput, 'tenantId' | 'lotId' | 'actor'>,
): NormalizedLotInspection | InspectionError {
  const qc = effectiveLotQcStatus(lot);
  if (qc !== 'QUARANTINE') {
    return { error: `Lot sudah diperiksa (status ${qc === 'RELEASED' ? 'lolos' : 'ditolak'} QC)`, status: 409 };
  }
  const rem = effectiveIngredientQtyRemaining(lot);
  if (lot.status === 'CONSUMED' || !(rem > 0)) return { error: 'Lot sudah habis — tidak ada yang diperiksa', status: 409 };

  const passed = parseQty(input.qtyPassed, 'Qty lolos');
  if (typeof passed !== 'number') return passed;
  const failed = parseQty(input.qtyFailed, 'Qty gagal');
  if (typeof failed !== 'number') return failed;
  const s = lot.satuan ? ` ${lot.satuan}` : '';
  if (!qtyEq(roundStockQty(passed + failed), rem)) {
    return { error: `Qty lolos + gagal harus sama dengan sisa lot (${rem}${s})`, status: 400 };
  }

  const kondisi = String(input.kondisi || '').trim().toUpperCase() as LotInspectionKondisi;
  if (!LOT_INSPECTION_KONDISI.includes(kondisi)) return { error: 'Kondisi barang wajib dipilih', status: 400 };

  const label = lot.productNama || lot.productKode || 'bahan';
  const wh = String(lot.warehouseKode || '').toUpperCase();
  const suhuRequired = (QC_TEMPERATURE_REQUIRED_WAREHOUSES as readonly string[]).includes(wh);
  const suhuRaw = input.suhuC;
  let suhuC: number | null = null;
  if (suhuRaw !== undefined && suhuRaw !== null && String(suhuRaw).trim() !== '') {
    const n = Number(String(suhuRaw).replace(',', '.'));
    if (!Number.isFinite(n) || n < QC_TEMPERATURE_MIN_C || n > QC_TEMPERATURE_MAX_C) {
      return { error: `Suhu terima harus angka ${QC_TEMPERATURE_MIN_C}–${QC_TEMPERATURE_MAX_C} °C`, status: 400 };
    }
    suhuC = Math.round(n * 10) / 10;
  } else if (suhuRequired) {
    return { error: `Suhu terima wajib untuk bahan basah (${label})`, status: 400 };
  }

  const alasanTolak = String(input.alasanTolak ?? '').trim().slice(0, 500);
  if (failed > 0 && alasanTolak.length < 3) return { error: 'Alasan penolakan wajib diisi', status: 400 };
  if (failed > 0 && kondisi === 'BAIK') {
    return { error: 'Kondisi "Baik" tidak cocok dengan qty gagal — pilih kondisi penolakan', status: 400 };
  }
  const catatan = String(input.catatan ?? '').trim().slice(0, 500);

  const hasil: LotInspectionHasil = failed <= 0 ? 'LOLOS' : passed <= 0 ? 'DITOLAK' : 'SEBAGIAN';
  return {
    qtyPassed: passed,
    qtyFailed: failed,
    suhuC,
    kondisi,
    hasil,
    ...(failed > 0 ? { alasanTolak } : {}),
    ...(catatan ? { catatan } : {}),
  };
}

export type LotInspectionResult =
  | { ok: true; inspection: LotInspectionDoc; lot: IngredientLotDoc; rejectedLot?: IngredientLotDoc }
  | { ok: false; error: string; status: number };

class InspectionAbort extends Error {
  constructor(readonly result: InspectionError) {
    super(result.error);
  }
}

/**
 * Catat inspeksi QC satu lot karantina, atomik:
 * LOLOS → RELEASED; DITOLAK → REJECTED (tindak lanjut PENDING); SEBAGIAN → lot asal RELEASED
 * dengan qty lolos + lot baru REJECTED berisi qty gagal (nomor lot `<asal>-R`).
 */
export async function inspectIngredientLot(db: Db, input: LotInspectionInput): Promise<LotInspectionResult> {
  const tid = input.tenantId || 'default';
  if (!input.actor?.userId) return { ok: false, error: 'Unauthorized', status: 401 };
  try {
    return await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const lot = await txDb.collection(INGREDIENT_LOTS_COLLECTION).findOne(
        { tenantId: tid, id: input.lotId },
        txOpts(session),
      ) as unknown as IngredientLotDoc | null;
      if (!lot) throw new InspectionAbort({ error: 'Lot tidak ditemukan', status: 404 });

      const norm = validateLotInspection(lot, input);
      if ('error' in norm) throw new InspectionAbort(norm);

      let receiverId = lot.receivedByUserId || '';
      if (!receiverId && lot.grnId) {
        const grn = await txDb.collection('goods_receipts').findOne(
          { ...tenantIdMatchFilter(tid), id: lot.grnId },
          { projection: { receivedBy: 1 }, ...txOpts(session) },
        ) as { receivedBy?: { userId?: string } } | null;
        receiverId = String(grn?.receivedBy?.userId || '');
      }
      const sod = lotInspectionSodError(input.actor, receiverId);
      if (sod) throw new InspectionAbort({ error: sod, status: 403 });

      const now = new Date();
      const noInspeksi = await nextDocNumber(txDb, tid, 'QCI', 'QCI', session);
      const inspectionId = uuidv4();
      const rem = effectiveIngredientQtyRemaining(lot);
      const qcStamp = { qcInspectionId: inspectionId, noInspeksi, qcInspectedAt: now, updatedAt: now };
      const cas = { tenantId: tid, id: lot.id, qcStatus: 'QUARANTINE', updatedAt: lot.updatedAt ?? null };

      let rejectedLot: IngredientLotDoc | undefined;
      let lotSet: Record<string, unknown>;
      if (norm.hasil === 'LOLOS') {
        lotSet = { qcStatus: 'RELEASED', ...qcStamp };
      } else if (norm.hasil === 'DITOLAK') {
        lotSet = { qcStatus: 'REJECTED', qcRejectStatus: 'PENDING', qcRejectReason: norm.alasanTolak, ...qcStamp };
      } else {
        lotSet = {
          qcStatus: 'RELEASED',
          qty: Math.max(norm.qtyPassed, roundStockQty(Number(lot.qty || rem) - norm.qtyFailed)),
          qtyRemaining: norm.qtyPassed,
          ...qcStamp,
        };
        const { _id: _omit, ...rest } = lot as IngredientLotDoc & { _id?: unknown };
        void _omit;
        let splitNo = `${lot.lotNo}-R`;
        const clash = await txDb.collection(INGREDIENT_LOTS_COLLECTION).findOne(
          { tenantId: tid, lotNo: splitNo },
          { projection: { id: 1 }, ...txOpts(session) },
        );
        if (clash) splitNo = `${lot.lotNo}-R-${inspectionId.slice(0, 8)}`;
        const {
          lastConsumedBy: _consumed,
          lastCycleCountBy: _counted,
          lastRelocatedBy: _relocated,
          relocatedFromLotId: _fromLot,
          qcRejectRtvId: _rtvId,
          qcRejectNoReturn: _rtvNo,
          qcDisposal: _disposal,
          ...splitRest
        } = rest;
        void _consumed; void _counted; void _relocated; void _fromLot; void _rtvId; void _rtvNo; void _disposal;
        rejectedLot = {
          ...splitRest,
          id: uuidv4(),
          lotNo: splitNo,
          qty: norm.qtyFailed,
          qtyRemaining: norm.qtyFailed,
          qcStatus: 'REJECTED',
          qcRejectStatus: 'PENDING',
          qcRejectReason: norm.alasanTolak,
          qcSplitFromLotId: lot.id,
          qcInspectionId: inspectionId,
          noInspeksi,
          qcInspectedAt: now,
          createdAt: now,
          updatedAt: now,
        };
      }

      const upd = await txDb.collection(INGREDIENT_LOTS_COLLECTION).updateOne(cas, { $set: lotSet }, txOpts(session));
      if (upd.matchedCount === 0) {
        throw new InspectionAbort({ error: 'Lot berubah bersamaan (sudah diperiksa/dipakai) — muat ulang', status: 409 });
      }
      if (rejectedLot) await txDb.collection(INGREDIENT_LOTS_COLLECTION).insertOne(rejectedLot, txOpts(session));
      if (norm.hasil === 'DITOLAK' || rejectedLot) {
        await capActiveAllocationTo(txDb, session, {
          tenantId: tid,
          lotId: lot.id,
          qty: norm.hasil === 'DITOLAK' ? 0 : norm.qtyPassed,
          at: now,
        });
      }

      const inspection: LotInspectionDoc = {
        id: inspectionId,
        tenantId: tid,
        noInspeksi,
        lotId: lot.id,
        lotNo: lot.lotNo,
        ...(rejectedLot ? { rejectedLotId: rejectedLot.id, rejectedLotNo: rejectedLot.lotNo } : {}),
        ...(lot.grnId ? { grnId: lot.grnId } : {}),
        ...(lot.noGRN ? { noGRN: lot.noGRN } : {}),
        productId: lot.productId,
        productKode: lot.productKode,
        productNama: lot.productNama,
        warehouseKode: lot.warehouseKode,
        satuan: lot.satuan,
        qtyInspected: rem,
        qtyPassed: norm.qtyPassed,
        qtyFailed: norm.qtyFailed,
        suhuC: norm.suhuC,
        kondisi: norm.kondisi,
        hasil: norm.hasil,
        ...(norm.alasanTolak ? { alasanTolak: norm.alasanTolak } : {}),
        ...(norm.catatan ? { catatan: norm.catatan } : {}),
        ...(receiverId ? { receivedByUserId: receiverId } : {}),
        inspectedBy: { userId: input.actor.userId, userName: input.actor.userName, role: input.actor.role },
        inspectedAt: now,
        createdAt: now,
      };
      await txDb.collection(LOT_INSPECTIONS_COLLECTION).insertOne({ ...inspection }, txOpts(session));

      const s = lot.satuan ? ` ${lot.satuan}` : '';
      await writeAuditLog(txDb, {
        tenantId: tid,
        action: 'LOT_QC_INSPECTION',
        entityType: 'ingredient_lot',
        entityId: lot.id,
        summary: `${noInspeksi}: lot ${lot.lotNo} ${lot.productNama || lot.productKode || ''} — `
          + `lolos ${norm.qtyPassed}${s}, gagal ${norm.qtyFailed}${s}`,
        userId: input.actor.userId,
        userName: input.actor.userName,
        metadata: {
          noInspeksi,
          hasil: norm.hasil,
          suhuC: norm.suhuC,
          kondisi: norm.kondisi,
          qtyPassed: norm.qtyPassed,
          qtyFailed: norm.qtyFailed,
          ...(rejectedLot ? { rejectedLotId: rejectedLot.id, rejectedLotNo: rejectedLot.lotNo } : {}),
        },
      }, session);

      const fresh = await txDb.collection(INGREDIENT_LOTS_COLLECTION).findOne(
        { tenantId: tid, id: lot.id },
        txOpts(session),
      ) as unknown as IngredientLotDoc;
      return { ok: true as const, inspection, lot: fresh, ...(rejectedLot ? { rejectedLot } : {}) };
    });
  } catch (e) {
    if (e instanceof InspectionAbort) return { ok: false, ...e.result };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Tindak lanjut lot ditolak → RTV
// ---------------------------------------------------------------------------

/** Lot REJECTED yang masih bisa ditindaklanjuti (retur/pemusnahan). */
export async function loadRejectedLotForFollowUp(
  db: Db,
  tenantId: string,
  lotId: string,
  session?: ClientSession,
): Promise<IngredientLotDoc | { error: string; status: number }> {
  const lot = await db.collection(INGREDIENT_LOTS_COLLECTION).findOne(
    { tenantId: tenantId || 'default', id: lotId },
    txOpts(session),
  ) as unknown as IngredientLotDoc | null;
  if (!lot) return { error: 'Lot tidak ditemukan', status: 404 };
  if (effectiveLotQcStatus(lot) !== 'REJECTED') return { error: 'Lot ini tidak berstatus ditolak QC', status: 400 };
  if (!qtyGt(effectiveIngredientQtyRemaining(lot), 0)) return { error: 'Lot ditolak sudah habis', status: 400 };
  if ((lot.qcRejectStatus || 'PENDING') !== 'PENDING') {
    return {
      error: lot.qcRejectStatus === 'RTV_CREATED'
        ? `Lot ini sudah punya retur ${lot.qcRejectNoReturn || ''}`.trim()
        : 'Lot ini sudah ditindaklanjuti',
      status: 409,
    };
  }
  return lot;
}

/** Klaim atomik lot REJECTED (PENDING → RTV_CREATED) di sesi yang sama dengan insert RTV. */
export async function claimRejectedLotForRtv(
  db: Db,
  session: ClientSession | undefined,
  input: { tenantId: string; lotId: string; rtvId: string; noReturn: string },
): Promise<boolean> {
  const res = await db.collection(INGREDIENT_LOTS_COLLECTION).updateOne(
    {
      tenantId: input.tenantId || 'default',
      id: input.lotId,
      qcStatus: 'REJECTED',
      $or: [{ qcRejectStatus: 'PENDING' }, { qcRejectStatus: { $exists: false } }],
    },
    {
      $set: {
        qcRejectStatus: 'RTV_CREATED',
        qcRejectRtvId: input.rtvId,
        qcRejectNoReturn: input.noReturn,
        updatedAt: new Date(),
      },
    },
    txOpts(session),
  );
  return res.modifiedCount === 1;
}

/** Draft RTV dihapus → lot kembali menunggu tindak lanjut. */
export async function releaseRejectedLotRtvClaim(
  db: Db,
  session: ClientSession | undefined,
  input: { tenantId: string; lotId: string; rtvId: string },
): Promise<void> {
  await db.collection(INGREDIENT_LOTS_COLLECTION).updateOne(
    {
      tenantId: input.tenantId || 'default',
      id: input.lotId,
      qcRejectStatus: 'RTV_CREATED',
      qcRejectRtvId: input.rtvId,
    },
    {
      $set: { qcRejectStatus: 'PENDING', updatedAt: new Date() },
      $unset: { qcRejectRtvId: '', qcRejectNoReturn: '' },
    },
    txOpts(session),
  );
}

/** Tandai lot ditolak dimusnahkan (setelah stok keluar diposting di sesi yang sama). */
export async function markRejectedLotDisposed(
  db: Db,
  session: ClientSession | undefined,
  input: { tenantId: string; lotId: string; noDokumen: string; reason: string },
): Promise<boolean> {
  const res = await db.collection(INGREDIENT_LOTS_COLLECTION).updateOne(
    {
      tenantId: input.tenantId || 'default',
      id: input.lotId,
      qcStatus: 'REJECTED',
      $or: [{ qcRejectStatus: 'PENDING' }, { qcRejectStatus: { $exists: false } }],
    },
    {
      $set: {
        qcRejectStatus: 'DISPOSED',
        qcDisposal: { noDokumen: input.noDokumen, reason: input.reason, at: new Date() },
        updatedAt: new Date(),
      },
    },
    txOpts(session),
  );
  return res.modifiedCount === 1;
}

export type LotQcSummary = {
  quarantineLots: number;
  quarantineOver24h: number;
  rejectedPending: number;
  /** Lot karantina yang terpakai selain lewat hitung fisik (PS) / perbaikan drift lot — target selalu 0. */
  quarantineConsumed: number;
};

/** Ringkasan untuk panel ops. */
export async function summarizeLotQc(db: Db, tenantId: string): Promise<LotQcSummary> {
  const tid = tenantId || 'default';
  const col = db.collection(INGREDIENT_LOTS_COLLECTION);
  const live = { tenantId: tid, status: { $in: ['ACTIVE', 'EXPIRED'] } };
  const dayAgo = new Date(Date.now() - 24 * 3_600_000);
  const [quarantineLots, quarantineOver24h, rejectedPending, quarantineConsumed] = await Promise.all([
    col.countDocuments({ ...live, qcStatus: 'QUARANTINE' }),
    col.countDocuments({ ...live, qcStatus: 'QUARANTINE', createdAt: { $lt: dayAgo } }),
    col.countDocuments({
      ...live,
      qcStatus: 'REJECTED',
      $or: [{ qcRejectStatus: 'PENDING' }, { qcRejectStatus: { $exists: false } }],
    }),
    col.countDocuments({
      tenantId: tid,
      qcStatus: 'QUARANTINE',
      'lastConsumedBy.at': { $exists: true },
      'lastConsumedBy.noDokumen': { $not: /^(PS|LOT-REPAIR-)/ },
    }),
  ]);
  return { quarantineLots, quarantineOver24h, rejectedPending, quarantineConsumed };
}
