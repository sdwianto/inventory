/**
 * Unified stock mutation entrypoint (ADR-001 Phase 0).
 * Always updates stok_lokasi + stok_kartu + product.stok denorm.
 */

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  adjustStokLokasi,
  ensureStokLokasiRow,
  syncProductStokFromLokasi,
  parseLokasiKode,
} from '@/lib/api/stok-lokasi';
import { softConsumeBinOnWarehouseOut } from '@/lib/api/stok-bin-consume';
import { warehouseLabel } from '@/lib/api/warehouses';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { txOpts } from '@/lib/api/transaction';

export type StockMutationSourceType =
  | 'RELEASE'
  | 'GRN'
  | 'PENYESUAIAN'
  | 'TRANSFER'
  | 'MASTER_PRODUK'
  | 'FP_ISSUE'
  | 'FP_RESULT'
  | 'FP_RESULT_WASTE'
  | 'FP_DIST'
  | 'FP_DIST_RETURN'
  | 'FP_ADJUST'
  | string;

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
}

export type PostStockMutationResult =
  | { ok: true; qtyAfter: number; lokasiKode: string }
  | { ok: false; error: string };

export async function postStockMutation(
  db: Db,
  input: PostStockMutationInput,
): Promise<PostStockMutationResult> {
  const tid = input.tenantId || 'default';
  const lokasiKode = parseLokasiKode(input.warehouseKode);
  const delta = Number(input.deltaQtyBase);
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: false, error: 'Qty mutasi stok tidak valid' };
  }
  if (!input.productId || !input.noTransaksi) {
    return { ok: false, error: 'productId dan noTransaksi wajib' };
  }

  await ensureStokLokasiRow(db, tid, input.productId, lokasiKode, input.session);
  const adj = await adjustStokLokasi(
    db,
    tid,
    input.productId,
    lokasiKode,
    delta,
    input.session,
  );
  if ('error' in adj && adj.error) {
    return { ok: false, error: adj.error };
  }

  // W2-19/W2-20: soft bin OUT after warehouse qty succeeded — never fail mutation on shortfall.
  if (delta < 0) {
    await softConsumeBinOnWarehouseOut(
      db,
      tid,
      input.productId,
      lokasiKode,
      -delta,
      input.session,
    );
  }

  const qtyAfter = await syncProductStokFromLokasi(db, tid, input.productId, input.session);
  const masuk = delta > 0 ? delta : 0;
  const keluar = delta < 0 ? -delta : 0;
  const lokasiLabel = `${lokasiKode} - ${warehouseLabel(lokasiKode)}`;

  await db.collection('stok_kartu').insertOne(
    stampTenantId(tid, {
      id: uuidv4(),
      stokId: input.productId,
      lokasi: lokasiLabel,
      lokasiKode,
      tanggal: new Date(),
      noTransaksi: input.noTransaksi,
      keterangan: input.keterangan,
      sourceType: input.sourceType,
      masuk,
      keluar,
      qtyEntered: input.qtyEntered,
      uomId: input.uomId,
      satuan: input.satuan,
      hargaSatuan: input.hargaSatuan ?? 0,
    }),
    txOpts(input.session),
  );

  return { ok: true, qtyAfter, lokasiKode };
}
