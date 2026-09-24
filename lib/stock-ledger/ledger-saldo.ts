// Saldo kartu stok (Σ masuk − keluar) — sumber kebenaran mutasi, dipakai guard keluar.

import type { ClientSession, Db } from 'mongodb';
import { getQtyStokLokasi } from '@/lib/api/stok-lokasi';
import { txOpts } from '@/lib/api/transaction';
import { roundStockQty } from '@/lib/stock-ledger/precision';
import { STOK_KARTU } from '@/lib/stock-ledger/balance';

export type LedgerSaldoInfo = {
  saldo: number;
  /** Ada ≥1 baris kartu — lokasi harus dibatasi saldo kartu. */
  hasActivity: boolean;
};

/** Batch saldo kartu per produk (untuk cek keluar & tampilan saldo). */
export async function ledgerSaldoForProducts(
  db: Db,
  tenantId: string,
  stokIds: string[],
  session?: ClientSession,
): Promise<Map<string, LedgerSaldoInfo>> {
  const tid = tenantId || 'default';
  const ids = [...new Set(stokIds.filter(Boolean))];
  const map = new Map<string, LedgerSaldoInfo>(
    ids.map((id) => [id, { saldo: 0, hasActivity: false }]),
  );
  if (!ids.length) return map;

  const rows = await db.collection(STOK_KARTU).aggregate<{
    _id: string;
    saldo: number;
    n: number;
  }>([
    { $match: { tenantId: tid, stokId: { $in: ids } } },
    {
      $group: {
        _id: '$stokId',
        saldo: {
          $sum: {
            $subtract: [{ $ifNull: ['$masuk', 0] }, { $ifNull: ['$keluar', 0] }],
          },
        },
        n: { $sum: 1 },
      },
    },
  ], txOpts(session)).toArray();

  for (const r of rows) {
    const id = String(r._id || '');
    if (!id) continue;
    map.set(id, {
      saldo: roundStockQty(r.saldo),
      hasActivity: (Number(r.n) || 0) > 0,
    });
  }
  return map;
}

/**
 * Qty yang boleh dikeluarkan dari gudang.
 * Jika sudah ada jejak kartu stok, lokasi tidak boleh melebihi max(0, saldo kartu)
 * — mencegah oversell saat stok_lokasi menggelembung (phantom / multi-gudang).
 * Tanpa jejak kartu (seed awal), percaya qty lokasi.
 */
export function availableQtyAgainstLedger(
  lokasiQty: number,
  ledger: Pick<LedgerSaldoInfo, 'saldo' | 'hasActivity'> | null | undefined,
): number {
  const onHand = Math.max(0, roundStockQty(lokasiQty));
  if (!ledger?.hasActivity) return onHand;
  return Math.min(onHand, Math.max(0, roundStockQty(ledger.saldo)));
}

/** Source type yang boleh melebihi saldo kartu (koreksi / inbound). */
export function shouldEnforceLedgerOnOutbound(sourceType: string | null | undefined): boolean {
  const t = String(sourceType || '').toUpperCase();
  if (!t) return true;
  const skip = new Set([
    'PENYESUAIAN',
    'MASTER_PRODUK',
    'FP_ADJUST',
    'GRN',
    'VENDOR_RETURN_REJECTED',
    'FP_RESULT',
    'FP_DIST_RETURN',
    'REPAIR_LEDGER_LOKASI_DRIFT',
    'RELOKASI_GUDANG',
  ]);
  return !skip.has(t);
}

export async function getAvailableQtyAtLokasi(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
  lokasiKode: string | null | undefined,
  session?: ClientSession,
): Promise<number> {
  const tid = tenantId || 'default';
  const lokasiQty = roundStockQty(await getQtyStokLokasi(db, tid, stokId, lokasiKode, session));
  const infoMap = await ledgerSaldoForProducts(db, tid, [stokId], session);
  return availableQtyAgainstLedger(lokasiQty, infoMap.get(stokId));
}
