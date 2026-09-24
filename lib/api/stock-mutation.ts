/**
 * Adapter satu baris untuk postStockMovements (lib/stock-ledger).
 * Always updates stok_lokasi + stok_kartu + product.stok denorm in the caller's session.
 */

import type { ClientSession, Db } from 'mongodb';
import { postStockMovements, type StockActor, type StockLotPolicy, type StockSourceType } from '@/lib/stock-ledger';

export type StockMutationSourceType = StockSourceType;

export interface PostStockMutationInput {
  tenantId: string;
  productId: string;
  /** Warehouse kode (GKERING / GBASAH) or lokasi string. */
  warehouseKode: string;
  /** Positive = masuk, negative = keluar (base UOM qty). */
  deltaQtyBase: number;
  sourceType: StockMutationSourceType;
  noTransaksi: string;
  keterangan: string;
  hargaSatuan?: number;
  qtyEntered?: number;
  uomId?: string;
  satuan?: string;
  session?: ClientSession;
  /** Id dokumen sumber (kunci idempotensi bersama lineRef). */
  sourceId: string;
  /** Unik per dokumen sumber; default productId. */
  lineRef?: string;
  actor?: StockActor | null;
  postingDate?: Date;
  kartuExtra?: Record<string, unknown>;
  lotPolicy?: StockLotPolicy;
}

export type PostStockMutationResult =
  | { ok: true; qtyAfter: number; lokasiKode: string; kartuId: string; lot?: import('@/lib/stock-ledger').LotPostingResult }
  | { ok: false; error: string };

export async function postStockMutation(
  db: Db,
  input: PostStockMutationInput,
): Promise<PostStockMutationResult> {
  if (!input.productId || !input.noTransaksi) {
    return { ok: false, error: 'productId dan noTransaksi wajib' };
  }
  const res = await postStockMovements(db, input.session, {
    tenantId: input.tenantId || 'default',
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    noTransaksi: input.noTransaksi,
    keterangan: input.keterangan,
    postingDate: input.postingDate,
    actor: input.actor,
    lines: [{
      lineRef: input.lineRef || input.productId,
      productId: input.productId,
      warehouseKode: input.warehouseKode,
      deltaQtyBase: Number(input.deltaQtyBase),
      unitCost: input.hargaSatuan,
      qtyEntered: input.qtyEntered,
      uomId: input.uomId,
      satuan: input.satuan,
      kartuExtra: input.kartuExtra,
      lotPolicy: input.lotPolicy,
    }],
  });
  if (!res.ok) return { ok: false, error: res.error };
  const line = res.lines[0];
  return {
    ok: true,
    qtyAfter: res.productStok[input.productId] ?? 0,
    lokasiKode: line.lokasiKode,
    kartuId: line.kartuId,
    ...(line.lot ? { lot: line.lot } : {}),
  };
}
