// Koreksi qty/jumlah per baris hutang dari qtyReceived GRN — modul terpisah tanpa
// dependensi lain supaya bisa dipakai baik saat hutang DIBUAT/DISINKRON dari invoice
// vendor (hutang-from-vendor.ts) maupun saat reconcile ulang record lama (hutang-reconcile.ts)
// tanpa import siklis di antara keduanya.

import type { GrnDoc } from '@/types/documents';

export type HutangItemLike = Record<string, unknown> & {
  lineId?: string;
  qty?: number | string;
  harga?: number | string;
  jumlah?: number | string;
};

/**
 * Koreksi qty/jumlah per baris hutang dari qtyReceived GRN (bukan qty ditolak/ordered) —
 * cocokkan lewat lineId, sama seperti GRN item's lineId (dikonfirmasi identik untuk baris
 * yang berasal dari GRN yang sama). Baris tanpa lineId cocok dibiarkan apa adanya — jangan
 * menebak identitas baris invoice. Harga tidak diubah (mismatch harga kategori terpisah).
 */
export function reconcileHutangItemsFromGrn(
  hutangItems: HutangItemLike[],
  grnItems: GrnDoc['items'],
): { items: HutangItemLike[]; total: number; changed: boolean; matchedCount: number } {
  const grnByLineId = new Map((grnItems || []).map((it) => [String(it.lineId || ''), it]));
  let changed = false;
  let matchedCount = 0;
  const items = hutangItems.map((it) => {
    const harga = parseInt(String(it.harga || 0), 10) || 0;
    const currentQty = parseFloat(String(it.qty || 0)) || 0;
    const lineId = String(it.lineId || '').trim();
    const grnItem = lineId ? grnByLineId.get(lineId) : undefined;
    if (!grnItem) {
      return { ...it, jumlah: Math.round(currentQty * harga) };
    }
    matchedCount += 1;
    const correctedQty = parseFloat(String(grnItem.qtyReceived ?? grnItem.qtyOrdered)) || 0;
    if (Math.abs(currentQty - correctedQty) > 1e-9) changed = true;
    return { ...it, qty: correctedQty, jumlah: Math.round(correctedQty * harga) };
  });
  const total = items.reduce((s, it) => s + (parseInt(String(it.jumlah ?? 0), 10) || 0), 0);
  return { items, total, changed, matchedCount };
}
