// Mutasi lot bahan (ingredient_lots) per baris posting, di sesi yang sama dengan saldo gudang.

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { txOpts } from '@/lib/api/transaction';
import type { FefoAllocation } from '@/lib/food-production/fefo-allocate';
import { INGREDIENT_LOTS_COLLECTION, parseIsoDateOnly, type IngredientLotDoc } from '@/lib/food-production/ingredient-lot';
import {
  consumeIngredientLotsFefo,
  restoreIngredientLotsFromAllocations,
  type LotQcHeldMode,
} from '@/lib/stock-ledger/lot-consume';
import { relocateLotsFefo } from '@/lib/stock-ledger/lot-relocate';
import { syncLotsOnVariance } from '@/lib/stock-ledger/lot-cycle-count';
import { parseLokasiKode } from '@/lib/api/stok-lokasi';
import { roundStockQty } from '@/lib/stock-ledger/precision';

export type StockLotPolicy =
  | { mode: 'NONE' }
  /** Keluar: konsumsi lot FEFO (tanpa lot / kurang = lunak, dilaporkan Detect). */
  | {
    mode: 'FEFO_CONSUME';
    allowExpired?: boolean;
    preferredLotNo?: string | null;
    qcHeld?: LotQcHeldMode;
    reservationPlanId?: string | null;
    reservationOverride?: boolean;
  }
  /** Keluar: pindahkan lot FEFO ke gudang tujuan (baris masuk pasangannya tanpa lotPolicy). */
  | { mode: 'RELOCATE'; toWarehouseKode: string; allowExpired?: boolean }
  /** Masuk: kembalikan qty ke lot dari alokasi konsumsi sebelumnya. */
  | { mode: 'RESTORE'; restores: FefoAllocation[] }
  /** Masuk: buat lot baru; qty/produk/gudang dipaksa sama dengan baris posting. */
  | { mode: 'CREATE'; lot: StockLotCreateInput }
  /** ± hitung fisik: kurang → FEFO consume, lebih → tambah lot terbaru / lot PENYESUAIAN baru. */
  | { mode: 'VARIANCE' };

export type StockLotCreateInput = Partial<Omit<IngredientLotDoc, 'tenantId' | 'productId' | 'warehouseKode' | 'qty' | 'qtyRemaining'>>
  & Pick<IngredientLotDoc, 'lotNo' | 'receivedAt' | 'expiryDate'>;

export type LotPostingResult = {
  mode: StockLotPolicy['mode'];
  allocated: number;
  shortfall: number;
  skippedNoLots: boolean;
  allocations: FefoAllocation[];
  lotId?: string;
  lotNo?: string;
  /** Field yang ikut disimpan di baris kartu stok. */
  kartuFields: Record<string, unknown>;
};

interface ApplyLotPolicyInput {
  tenantId: string;
  sourceType: string;
  sourceId?: string;
  noTransaksi: string;
  postingDate: Date;
  productId: string;
  product: { kode?: string; nama?: string; shelfLifeDays?: number | null };
  lokasiKode: string;
  delta: number;
  policy: StockLotPolicy;
  satuan?: string;
}

export async function applyLotPolicy(
  db: Db,
  session: ClientSession | undefined,
  input: ApplyLotPolicyInput,
): Promise<LotPostingResult | { error: string }> {
  const { policy, tenantId, productId, lokasiKode, postingDate, noTransaksi, sourceId } = input;
  const qty = Math.abs(roundStockQty(input.delta));

  switch (policy.mode) {
    case 'FEFO_CONSUME': {
      const r = await consumeIngredientLotsFefo(db, {
        tenantId,
        stokId: productId,
        warehouseKode: lokasiKode,
        needQty: qty,
        asOf: postingDate,
        allowExpired: policy.allowExpired,
        issueId: sourceId,
        noDokumen: noTransaksi,
        preferredLotNo: policy.preferredLotNo,
        qcHeld: policy.qcHeld,
        reservationPlanId: policy.reservationPlanId,
        reservationOverride: policy.reservationOverride,
      }, session);
      if (policy.qcHeld === 'PREFERRED' && (r.shortfall > 0 || r.skippedNoLots)) {
        const which = String(policy.preferredLotNo || '').trim();
        return {
          error: which
            ? `Lot ${which} tidak terpakai penuh (${r.allocated} dari ${qty}). Retur dan pemusnahan QC hanya boleh mengambil lot itu.`
            : `Lot ditolak QC tidak terpakai penuh (${r.allocated} dari ${qty}).`,
        };
      }
      return {
        mode: policy.mode,
        allocated: r.allocated,
        shortfall: r.shortfall,
        skippedNoLots: r.skippedNoLots,
        allocations: r.allocations,
        kartuFields: { ingredientLotAllocations: r.allocations },
      };
    }
    case 'RELOCATE': {
      const toWh = parseLokasiKode(policy.toWarehouseKode);
      const r = await relocateLotsFefo(db, {
        tenantId,
        stokId: productId,
        fromWarehouseKode: lokasiKode,
        toWarehouseKode: toWh,
        needQty: qty,
        asOf: postingDate,
        allowExpired: policy.allowExpired ?? true,
        noTransaksi,
        ...(input.sourceType === 'FP_XFER' ? { xferId: sourceId } : { transferId: sourceId }),
      }, session);
      return {
        mode: policy.mode,
        allocated: r.allocated,
        shortfall: r.shortfall,
        skippedNoLots: r.skippedNoLots,
        allocations: r.allocations,
        kartuFields: { ingredientLotAllocations: r.allocations },
      };
    }
    case 'RESTORE': {
      const r = await restoreIngredientLotsFromAllocations(db, {
        tenantId,
        stokId: productId,
        restores: policy.restores || [],
        asOf: postingDate,
        noDokumen: noTransaksi,
        returnId: sourceId,
      }, session);
      return {
        mode: policy.mode,
        allocated: r.restored,
        shortfall: r.shortfall,
        skippedNoLots: !(policy.restores || []).length,
        allocations: r.allocations,
        kartuFields: { ingredientLotRestores: r.allocations },
      };
    }
    case 'CREATE': {
      const lot: IngredientLotDoc = {
        ...policy.lot,
        id: policy.lot.id || uuidv4(),
        tenantId,
        productId,
        warehouseKode: lokasiKode,
        qty,
        qtyRemaining: qty,
        status: policy.lot.status || 'ACTIVE',
        createdAt: policy.lot.createdAt || postingDate,
        updatedAt: postingDate,
      };
      if (!String(lot.lotNo || '').trim()) return { error: 'Nomor lot wajib' };
      const expiry = parseIsoDateOnly(lot.expiryDate);
      if (!expiry) return { error: `Tanggal kedaluwarsa lot ${lot.lotNo} tidak valid (format YYYY-MM-DD)` };
      const received = parseIsoDateOnly(lot.receivedAt);
      if (received && expiry < received) {
        return { error: `Lot ${lot.lotNo} kedaluwarsa (${expiry}) sebelum tanggal terima ${received}` };
      }
      lot.expiryDate = expiry;
      await db.collection(INGREDIENT_LOTS_COLLECTION).insertOne(lot, txOpts(session));
      return {
        mode: policy.mode,
        allocated: qty,
        shortfall: 0,
        skippedNoLots: false,
        allocations: [],
        lotId: lot.id,
        lotNo: lot.lotNo,
        kartuFields: { lotId: lot.id, lotNo: lot.lotNo },
      };
    }
    case 'VARIANCE': {
      const r = await syncLotsOnVariance(db, {
        tenantId,
        stokId: productId,
        warehouseKode: lokasiKode,
        deltaQty: roundStockQty(input.delta),
        asOf: postingDate,
        noDokumen: noTransaksi,
        penyesuaianId: sourceId,
        productKode: input.product.kode,
        productNama: input.product.nama,
        shelfLifeDays: input.product.shelfLifeDays,
        satuan: input.satuan,
      }, session);
      if ('error' in r) return { error: r.error };
      const moved = roundStockQty(r.consumed ?? r.increased ?? 0);
      return {
        mode: policy.mode,
        allocated: moved,
        shortfall: roundStockQty(r.shortfall ?? 0),
        skippedNoLots: r.skippedNoLots,
        allocations: [],
        ...(r.createdLotId ? { lotId: r.createdLotId } : {}),
        kartuFields: { lotSync: r },
      };
    }
    default:
      return { mode: 'NONE', allocated: 0, shortfall: 0, skippedNoLots: true, allocations: [], kartuFields: {} };
  }
}
