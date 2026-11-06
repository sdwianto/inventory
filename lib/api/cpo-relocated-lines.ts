// Cakupan pengadaan untuk baris PO yang dipindah ke PO lain (lihat cpo-extra-so-lines).

import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import type { JsonObject } from '@/types/json';

type LineRef = { poId: string; noPO?: string; lineId: string };

/** PO tujuan tempat baris virtual sebenarnya dipesan/diterima. */
export type RelocatedVia = { poId: string; noPO?: string; status?: string; lineId: string };

type RelocatableLine = JsonObject & {
  lineId?: string;
  localStokId?: string | null;
  kode?: string;
  vendorKode?: string;
  nama?: string;
  satuan?: string;
  uomId?: string | null;
  qty?: number | string;
  qtyReceived?: number;
  qtyShortClosed?: number;
  qtyRejected?: number;
  cancelled?: boolean;
  relocatedTo?: LineRef;
  relocatedVirtual?: boolean;
  relocatedVia?: RelocatedVia;
};

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * Untuk perhitungan cakupan pengadaan: baris yang dibatalkan karena dipindah ke PO lain diganti
 * baris virtual berisi identitas barang + qty/qty diterima baris tujuan, supaya kebutuhan tetap
 * terhitung terpenuhi. `relocatedVia` menunjuk PO tujuan. PO tujuan yang sudah ikut dihitung
 * (`countedPoIds`) dilewati agar tidak ganda; PO tujuan DRAFT/REJECTED/CANCELLED tidak dihitung.
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
    .project({ id: 1, noPO: 1, status: 1, items: 1 })
    .toArray();
  const byKey = new Map<string, { line: RelocatableLine; noPO: string; status: string }>();
  for (const t of targets) {
    for (const l of (Array.isArray(t.items) ? t.items : []) as RelocatableLine[]) {
      if (!l.cancelled) byKey.set(`${str(t.id)}:${str(l.lineId)}`, { line: l, noPO: str(t.noPO), status: str(t.status) });
    }
  }
  return items.map((l) => {
    if (!l.cancelled || !l.relocatedTo || countedPoIds.has(str(l.relocatedTo.poId))) return l;
    const hit = byKey.get(`${str(l.relocatedTo.poId)}:${str(l.relocatedTo.lineId)}`);
    if (!hit) return l;
    const target = hit.line;
    // Identitas & qty diambil utuh dari baris tujuan: kunci pengadaan (kode + satuan) dan
    // konversi satuan harus konsisten dengan barang yang benar-benar dipesan di PO tujuan.
    const pick = <K extends keyof RelocatableLine>(k: K) => (target[k] ?? l[k]);
    return {
      ...l,
      cancelled: false,
      localStokId: pick('localStokId'),
      kode: pick('kode'),
      vendorKode: pick('vendorKode'),
      nama: pick('nama'),
      satuan: pick('satuan'),
      uomId: pick('uomId'),
      qty: target.qty,
      qtyReceived: target.qtyReceived,
      qtyShortClosed: target.qtyShortClosed,
      qtyRejected: target.qtyRejected,
      relocatedVirtual: true,
      relocatedVia: {
        poId: str(l.relocatedTo.poId),
        noPO: hit.noPO || l.relocatedTo.noPO,
        status: hit.status,
        lineId: str(l.relocatedTo.lineId),
      },
    } as T;
  });
}
