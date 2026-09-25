// Stok yang tidak boleh dipakai satu rencana: qty tertahan QC + cadangan rencana lain.

import type { Db } from 'mongodb';
import { loadLotQcHeld, lotQcHeldTotal, lotQcPairKey } from '@/lib/stock-ledger/lot-qc';
import { loadReservationPools, reservationBlockedQty, reservationPairKey } from '@/lib/stock-ledger/plan-reservation';
import { roundStockQty } from '@/lib/stock-ledger/precision';

export function planBlockedPairKey(productId: string, lokasiKode: string): string {
  return `${productId}\u0000${lokasiKode}`;
}

export async function loadPlanBlockedQty(
  db: Db,
  tenantId: string,
  pairs: Array<{ productId: string; lokasiKode: string }>,
  planId?: string | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const valid = pairs.filter((p) => p.productId && p.lokasiKode);
  if (!valid.length) return out;
  const [held, pools] = await Promise.all([
    loadLotQcHeld(db, tenantId, valid),
    loadReservationPools(db, tenantId, valid),
  ]);
  for (const { productId, lokasiKode } of valid) {
    const blocked = roundStockQty(
      lotQcHeldTotal(held.get(lotQcPairKey(productId, lokasiKode)))
      + reservationBlockedQty(pools.get(reservationPairKey(productId, lokasiKode)), { planId: planId || undefined }),
    );
    if (blocked > 0) out.set(planBlockedPairKey(productId, lokasiKode), blocked);
  }
  return out;
}
