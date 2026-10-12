// Cakupan pengadaan untuk baris PO yang dipindah ke PO lain (lihat cpo-extra-so-lines).

import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import type { JsonObject } from '@/types/json';

type LineRef = { poId: string; noPO?: string; lineId: string };

type RelocatableLine = JsonObject & {
  lineId?: string;
  localStokId?: string | null;
  satuan?: string;
  uomId?: string | null;
  qty?: number | string;
  qtyReceived?: number;
  qtyShortClosed?: number;
  cancelled?: boolean;
  relocatedTo?: LineRef;
};

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * Untuk perhitungan cakupan pengadaan: baris yang dibatalkan karena dipindah ke PO lain diganti
 * baris virtual berisi qty/qty diterima baris tujuan, supaya kebutuhan tetap terhitung terpenuhi.
 * PO tujuan yang sudah ikut dihitung (`countedPoIds`) dilewati agar tidak ganda.
 */
export async function expandRelocatedLines<T extends RelocatableLine>(
  db: Db,
  tenantId: string,
  items: T[],
  countedPoIds: Set<string>,
  session?: ClientSession,
): Promise<T[]> {
  const refs = items
    .filter((l) => l.cancelled && l.relocatedTo && !countedPoIds.has(str(l.relocatedTo.poId)))
    .map((l) => l.relocatedTo as LineRef);
  if (!refs.length) return items;
  const targets = await db.collection('customer_purchase_orders')
    .find(
      { tenantId, id: { $in: [...new Set(refs.map((r) => r.poId))] }, status: { $nin: ['CANCELLED', 'DRAFT', 'REJECTED'] } },
      txOpts(session),
    )
    .project({ id: 1, items: 1 })
    .toArray();
  const byKey = new Map<string, RelocatableLine>();
  for (const t of targets) {
    for (const l of (Array.isArray(t.items) ? t.items : []) as RelocatableLine[]) {
      if (!l.cancelled) byKey.set(`${str(t.id)}:${str(l.lineId)}`, l);
    }
  }
  return items.map((l) => {
    if (!l.cancelled || !l.relocatedTo) return l;
    const target = byKey.get(`${str(l.relocatedTo.poId)}:${str(l.relocatedTo.lineId)}`);
    if (!target) return l;
    return {
      ...l,
      cancelled: false,
      localStokId: target.localStokId || l.localStokId,
      satuan: target.satuan ?? l.satuan,
      uomId: target.uomId ?? l.uomId,
      qty: target.qty,
      qtyReceived: target.qtyReceived,
      qtyShortClosed: target.qtyShortClosed,
      relocatedVirtual: true,
    } as T;
  });
}
