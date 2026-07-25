/**
 * W2-18 — Putaway move (bin-to-bin) ledger document.
 * Same warehouse only; mutates `stok_bin` via adjustStokBin — no stok_lokasi / kartu / lot.
 */

import type { ClientSession, Db } from 'mongodb';
import { adjustStokBin } from '@/lib/api/stok-bin';
import {
  WAREHOUSE_BINS_COLLECTION,
  isValidBinKode,
  normalizeBinKode,
} from '@/lib/api/warehouse-bins';
import { isValidWarehouseKode, normalizeWarehouseKode } from '@/lib/api/warehouses';

export const PUTAWAY_MOVES_COLLECTION = 'putaway_moves';

export type PutawayStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';

export interface PutawayLine {
  stokId: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  fromBinKode: string;
  toBinKode: string;
  qty: number;
  qtyBase: number;
}

export interface PutawayMoveDoc {
  id: string;
  tenantId: string;
  noPutaway: string;
  warehouseKode: string;
  tanggal: Date | string;
  status: PutawayStatus;
  keterangan?: string;
  lines: PutawayLine[];
  createdAt: Date;
  updatedAt: Date;
  createdBy?: { userId?: string; userName?: string; role?: string };
  postedAt?: Date | null;
  postedBy?: { userId?: string; userName?: string; role?: string } | null;
  cancelledAt?: Date | null;
}

export type NormalizePutawayLineResult =
  | { ok: true; line: PutawayLine }
  | { ok: false; error: string };

/** Normalize + validate a putaway line (from≠to, qtyBase>0, valid bins). */
export function normalizePutawayLine(raw: Partial<PutawayLine> | Record<string, unknown>): NormalizePutawayLineResult {
  const stokId = String(raw.stokId || '').trim();
  if (!stokId) return { ok: false, error: 'stokId wajib' };

  const fromBinKode = normalizeBinKode(raw.fromBinKode as string | undefined);
  const toBinKode = normalizeBinKode(raw.toBinKode as string | undefined);
  if (!isValidBinKode(fromBinKode)) return { ok: false, error: 'fromBinKode tidak valid' };
  if (!isValidBinKode(toBinKode)) return { ok: false, error: 'toBinKode tidak valid' };
  if (fromBinKode === toBinKode) {
    return { ok: false, error: `Bin asal & tujuan tidak boleh sama (${fromBinKode})` };
  }

  const qty = parseFloat(String(raw.qty ?? raw.qtyBase ?? 0)) || 0;
  const qtyBase = parseFloat(String(raw.qtyBase ?? raw.qty ?? 0)) || 0;
  if (qtyBase <= 0) return { ok: false, error: 'qtyBase harus > 0' };

  return {
    ok: true,
    line: {
      stokId,
      kode: raw.kode != null ? String(raw.kode) : undefined,
      nama: raw.nama != null ? String(raw.nama) : undefined,
      satuan: raw.satuan != null ? String(raw.satuan) : undefined,
      fromBinKode,
      toBinKode,
      qty: qty > 0 ? qty : qtyBase,
      qtyBase,
    },
  };
}

/** Both bins must exist and be aktif in the same warehouse. */
export async function assertPutawayBinsAktif(
  db: Db,
  tenantId: string,
  warehouseKode: string | null | undefined,
  fromBin: string | null | undefined,
  toBin: string | null | undefined,
): Promise<{ ok: true; warehouseKode: string; fromBinKode: string; toBinKode: string } | { ok: false; error: string }> {
  const tid = tenantId || 'default';
  const wh = normalizeWarehouseKode(warehouseKode);
  if (!isValidWarehouseKode(wh)) {
    return { ok: false, error: `Gudang tidak valid: ${warehouseKode}` };
  }
  const fromBinKode = normalizeBinKode(fromBin);
  const toBinKode = normalizeBinKode(toBin);
  if (!isValidBinKode(fromBinKode) || !isValidBinKode(toBinKode)) {
    return { ok: false, error: 'Kode bin tidak valid' };
  }
  if (fromBinKode === toBinKode) {
    return { ok: false, error: `Bin asal & tujuan tidak boleh sama (${fromBinKode})` };
  }

  const rows = await db.collection(WAREHOUSE_BINS_COLLECTION).find({
    tenantId: tid,
    warehouseKode: wh,
    kode: { $in: [fromBinKode, toBinKode] },
    aktif: true,
  }).toArray();

  const aktif = new Set(rows.map((r) => normalizeBinKode(r.kode as string)));
  if (!aktif.has(fromBinKode)) {
    return { ok: false, error: `Bin asal ${fromBinKode} tidak aktif di ${wh}` };
  }
  if (!aktif.has(toBinKode)) {
    return { ok: false, error: `Bin tujuan ${toBinKode} tidak aktif di ${wh}` };
  }
  return { ok: true, warehouseKode: wh, fromBinKode, toBinKode };
}

/**
 * Apply bin ledger moves for a putaway document (same warehouse).
 * Throws Error when any adjustStokBin fails (e.g. OUT insufficient).
 */
export async function postPutawayMoveBins(
  db: Db,
  tenantId: string,
  doc: Pick<PutawayMoveDoc, 'warehouseKode' | 'lines' | 'noPutaway'>,
  session?: ClientSession,
): Promise<void> {
  const tid = tenantId || 'default';
  const wh = normalizeWarehouseKode(doc.warehouseKode);
  if (!isValidWarehouseKode(wh)) {
    throw new Error(`Gudang tidak valid: ${doc.warehouseKode}`);
  }

  for (const line of doc.lines || []) {
    const norm = normalizePutawayLine(line);
    if (!norm.ok) throw new Error(norm.error);
    const { stokId, fromBinKode, toBinKode, qtyBase } = norm.line;

    const out = await adjustStokBin(db, tid, stokId, wh, fromBinKode, -qtyBase, session);
    if ('error' in out && out.error) {
      throw new Error(`${stokId} ${fromBinKode}→${toBinKode}: ${out.error}`);
    }
    const inn = await adjustStokBin(db, tid, stokId, wh, toBinKode, qtyBase, session);
    if ('error' in inn && inn.error) {
      throw new Error(`${stokId} ${fromBinKode}→${toBinKode}: ${inn.error}`);
    }
  }
}
