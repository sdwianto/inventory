// Penyesuaian stok: kode alasan, snapshot qty sistem saat hitung dimulai, dan posting bersama
// untuk mode langsung (tanpa approval) maupun mode maker-checker (flag adjustmentApproval).

import type { ClientSession, Db } from 'mongodb';
import { getQtyStokLokasi } from '@/lib/api/stok-lokasi';
import { isZeroQty, purgeNonHomeLokasiRows, recomputeProductStok, roundStockQty } from '@/lib/stock-ledger';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { createJournalIfNotExists } from '@/lib/api/journal';
import { buildPenyesuaianJournalLines } from '@/lib/api/journal-lines';
import { postStockMutation } from '@/lib/api/stock-mutation';
import { postedLinesValue } from '@/lib/api/stock-cost-journal';
import { syncBatchesOnVariance } from '@/lib/food-production/cycle-count-fefo';
import { txOpts } from '@/lib/api/transaction';
import type { AuthContext } from '@/types/auth';

export const ADJUSTMENT_REASON_CODES = ['OPNAME', 'RUSAK', 'KEDALUWARSA', 'SALAH_INPUT', 'HILANG', 'LAINNYA'] as const;
export type AdjustmentReasonCode = typeof ADJUSTMENT_REASON_CODES[number];

export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReasonCode, string> = {
  OPNAME: 'Stock opname',
  RUSAK: 'Barang rusak',
  KEDALUWARSA: 'Kedaluwarsa',
  SALAH_INPUT: 'Koreksi salah input',
  HILANG: 'Hilang',
  LAINNYA: 'Lainnya',
};

export type AdjustmentStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'POSTING' | 'POSTED' | 'REJECTED' | 'CANCELLED';

export type AdjustmentActor = { userId: string; userName: string; role?: string };

export type AdjustmentLine = {
  stokId: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  uomId?: string;
  qtyEntered?: number | null;
  gudangKode: string;
  /** Qty sistem (base) saat hitung dimulai — dasar selisih. */
  qtySistem: number;
  /** Qty hasil hitung (base); null = belum dihitung (draft). */
  qtyAktual: number | null;
  selisih?: number;
  /** Qty sistem (base) saat posting — mutasi setelah snapshot tetap dipertahankan. */
  qtySistemPosting?: number;
  qtyAkhir?: number;
  fefoSync?: Record<string, unknown>;
  lotSync?: Record<string, unknown>;
};

export function isAdjustmentReasonCode(v: unknown): v is AdjustmentReasonCode {
  return typeof v === 'string' && (ADJUSTMENT_REASON_CODES as readonly string[]).includes(v);
}

/** Kode alasan wajib; LAINNYA wajib catatan. */
export function adjustmentReasonError(reasonCode: unknown, catatan: unknown): string | null {
  if (!isAdjustmentReasonCode(reasonCode)) {
    return `Pilih alasan penyesuaian (${ADJUSTMENT_REASON_CODES.join(', ')})`;
  }
  if (reasonCode === 'LAINNYA' && !String(catatan ?? '').trim()) {
    return 'Alasan "Lainnya" wajib diisi keterangannya';
  }
  return null;
}

export function actorFromAuth(auth: AuthContext | null | undefined): AdjustmentActor {
  return {
    userId: String(auth?.userId || ''),
    userName: String(auth?.name || auth?.email || 'System'),
    ...(auth?.role ? { role: String(auth.role) } : {}),
  };
}

/**
 * Maker-checker ketat: penyetuju tidak boleh pembuat atau pengaju dokumen, apa pun rolenya.
 * MASTER dikecualikan (darurat) — pemanggil wajib mencatat audit khusus.
 */
export function selfApprovalState(
  auth: AuthContext | null | undefined,
  makers: Array<{ userId?: unknown } | null | undefined>,
): 'ok' | 'blocked' | 'master_override' {
  const me = String(auth?.userId || '');
  const isMaker = !!me && makers.some((m) => m && String(m.userId || '') === me);
  if (!isMaker) return 'ok';
  return auth?.isMaster ? 'master_override' : 'blocked';
}

type ProductForPosting = {
  id: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  hargaBeli?: number | string;
  gudangKode?: string;
  mergedInto?: string | null;
  deletedAt?: unknown;
  [key: string]: unknown;
};

export async function loadAdjustmentProduct(
  db: Db,
  tenantId: string,
  stokId: string,
  session?: ClientSession,
): Promise<ProductForPosting | null> {
  return await db.collection('products').findOne({ tenantId, id: stokId }, txOpts(session)) as ProductForPosting | null;
}

export async function snapshotQtySistem(
  db: Db,
  tenantId: string,
  stokId: string,
  gudangKode: string,
  session?: ClientSession,
): Promise<number> {
  return roundStockQty(await getQtyStokLokasi(db, tenantId, stokId, gudangKode, session));
}

/**
 * Posting baris penyesuaian di dalam transaksi.
 * - mode IMMEDIATE: qty sistem dibaca sekarang, selisih = aktual − sekarang.
 * - mode SNAPSHOT: selisih = aktual − qtySistem snapshot; mutasi sejak snapshot tetap berlaku.
 */
export async function postAdjustmentLines(
  txDb: Db,
  session: ClientSession | undefined,
  input: {
    tenantId: string;
    docId: string;
    noPS: string;
    lines: AdjustmentLine[];
    mode: 'IMMEDIATE' | 'SNAPSHOT';
    now: Date;
    actor: AdjustmentActor;
    costingV2: boolean;
  },
): Promise<AdjustmentLine[]> {
  const { tenantId, docId, noPS, now, actor, costingV2 } = input;
  const out: AdjustmentLine[] = [];
  for (const [idx, line] of input.lines.entries()) {
    if (line.qtyAktual == null || !Number.isFinite(line.qtyAktual) || line.qtyAktual < 0) {
      throw new Error(`Qty aktual ${line.kode || line.stokId} belum diisi`);
    }
    const prod = await loadAdjustmentProduct(txDb, tenantId, line.stokId, session);
    if (!prod) throw new Error(`Produk ${line.kode || line.stokId} tidak ditemukan`);
    if (prod.deletedAt) throw new Error(`Produk ${line.kode || line.stokId} sudah dihapus`);
    if (prod.mergedInto) throw new Error(`Produk ${line.kode || line.stokId} sudah digabung ke item lain — buat ulang penyesuaian`);
    const lokasiKode = resolveProductGudangKode(prod);
    if (input.mode === 'SNAPSHOT' && lokasiKode !== line.gudangKode) {
      throw new Error(`Gudang ${line.kode || line.stokId} berubah sejak hitung dimulai (${line.gudangKode} → ${lokasiKode}) — buat ulang penyesuaian`);
    }
    await purgeNonHomeLokasiRows(txDb, tenantId, prod.id, lokasiKode, session);
    const qtyNow = await snapshotQtySistem(txDb, tenantId, prod.id, lokasiKode, session);
    const base = input.mode === 'IMMEDIATE' ? qtyNow : roundStockQty(line.qtySistem);
    const selisihRaw = roundStockQty(line.qtyAktual - base);
    const selisih = isZeroQty(selisihRaw) ? 0 : selisihRaw;
    const qtyAkhir = roundStockQty(qtyNow + selisih);
    if (qtyAkhir < 0 && !isZeroQty(qtyAkhir)) {
      throw new Error(`Stok ${line.kode || line.stokId} akan minus (${qtyAkhir}) — stok sekarang ${qtyNow}, selisih hitung ${selisih}`);
    }
    let fefoSync: Record<string, unknown> | undefined;
    let lotSync: Record<string, unknown> | undefined;
    let postedValue = 0;
    const hargaBeli = parseInt(String(prod.hargaBeli || 0), 10) || 0;

    if (selisih !== 0) {
      // qtyEntered baris = hasil hitung fisik; kartu butuh qty mutasi dalam satuan input.
      const enteredPerBase = line.qtyEntered != null && line.qtyAktual > 0 ? line.qtyEntered / line.qtyAktual : null;
      const posted = await postStockMutation(txDb, {
        tenantId,
        productId: prod.id,
        warehouseKode: lokasiKode,
        deltaQtyBase: selisih,
        sourceType: 'PENYESUAIAN',
        noTransaksi: noPS,
        keterangan: `Penyesuaian Stok ${selisih >= 0 ? '(+)' : '(-)'} ${noPS}`,
        hargaSatuan: hargaBeli,
        qtyEntered: enteredPerBase != null ? roundStockQty(Math.abs(selisih) * enteredPerBase) : undefined,
        uomId: enteredPerBase != null ? line.uomId : undefined,
        satuan: enteredPerBase != null ? line.satuan || prod.satuan : prod.satuan,
        session,
        sourceId: docId,
        lineRef: `${idx + 1}:${prod.id}`,
        postingDate: now,
        actor,
        lotPolicy: { mode: 'VARIANCE' },
      });
      if (!posted.ok) throw new Error(posted.error || `Gagal penyesuaian ${prod.kode || prod.id}`);
      postedValue = postedLinesValue([posted.line]);
      lotSync = posted.lot?.kartuFields.lotSync as Record<string, unknown> | undefined;
      fefoSync = await syncBatchesOnVariance(txDb, {
        tenantId,
        stokId: prod.id,
        warehouseKode: lokasiKode,
        deltaQty: selisih,
        asOf: now,
        noDokumen: noPS,
      }, session) as unknown as Record<string, unknown>;

      const jAmt = Math.round(costingV2 ? postedValue : Math.abs(selisih) * hargaBeli);
      const jLines = buildPenyesuaianJournalLines({
        noDoc: `${noPS}/${prod.kode}`,
        amount: jAmt,
        increase: selisih > 0,
      });
      if (jLines.length) {
        await createJournalIfNotExists(txDb, {
          tanggal: now,
          keterangan: `Penyesuaian ${prod.kode} ${noPS}`,
          sourceType: 'AUTO_PENYESUAIAN',
          sourceId: `${docId}:${prod.id}`,
          details: jLines,
          userName: actor.userName,
          tenantId,
        }, session);
      }
    } else {
      await recomputeProductStok(txDb, tenantId, prod.id, session);
    }

    out.push({
      ...line,
      kode: line.kode ?? prod.kode,
      nama: line.nama ?? prod.nama,
      satuan: line.satuan || prod.satuan,
      gudangKode: lokasiKode,
      qtySistem: input.mode === 'IMMEDIATE' ? qtyNow : roundStockQty(line.qtySistem),
      qtySistemPosting: qtyNow,
      selisih,
      qtyAkhir,
      ...(fefoSync ? { fefoSync } : {}),
      ...(lotSync ? { lotSync } : {}),
    });
  }
  return out;
}
