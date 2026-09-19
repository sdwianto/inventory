// Hitung estimasi belanja dari baris PO customer.

import { foldEmptySatuanMap, procurementLineKey } from '@/lib/food-production/procurement-line-key';

export type PoEstimasiLine = Record<string, unknown> & {
  qty?: number | string;
  estimasiHarga?: number | string;
  hargaBeliReferensi?: number | string;
  estimasiJumlah?: number;
  localStokId?: string;
  vendorTenantId?: string;
  vendorKode?: string;
  vendorStokId?: string;
  kode?: string;
  satuan?: string;
  uomId?: string;
};

export function computeLineEstimasi(it: PoEstimasiLine) {
  const qty = parseFloat(String(it.qty)) || 0;
  const estimasiHarga = parseInt(String(it.estimasiHarga || it.hargaBeliReferensi || 0), 10);
  const estimasiJumlah = Math.round(qty * estimasiHarga);
  return { ...it, qty, estimasiHarga, estimasiJumlah };
}

export function sumPoEstimasi(items: PoEstimasiLine[]) {
  return (items || []).reduce((s: number, it) => s + (Number(it.estimasiJumlah) || 0), 0);
}

type MergedPoLine = ReturnType<typeof computeLineEstimasi>;

/** Pertahankan identitas baris yang sudah sync vendor / punya harga. */
function preferMergedPoLine(a: MergedPoLine, b: MergedPoLine): MergedPoLine {
  const score = (x: MergedPoLine) =>
    (x.vendorStokId ? 4 : 0)
    + ((Number(x.estimasiHarga) || 0) > 0 ? 2 : 0)
    + (x.uomId ? 1 : 0);
  return score(b) > score(a) ? b : a;
}

/** Gabung baris PO dengan kode item + satuan yang sama (bukan productId salinan vendor). */
export function mergePoItemsByStokId(items: PoEstimasiLine[]) {
  const map = new Map<string, MergedPoLine>();
  for (const raw of items || []) {
    const it = computeLineEstimasi(raw);
    const hasIdentity = Boolean(
      String(it.localStokId || '').trim()
      || String(it.kode || it.vendorKode || '').trim()
      || String(it.vendorTenantId || '').trim(),
    );
    if (!hasIdentity) continue;
    const key = procurementLineKey({
      productId: it.localStokId,
      kode: it.kode,
      vendorKode: it.vendorKode,
      satuan: it.satuan,
      uomId: it.uomId,
      localStokId: it.localStokId,
    });
    const prev = map.get(key);
    if (prev) {
      const qty = (parseFloat(String(prev.qty)) || 0) + (parseFloat(String(it.qty)) || 0);
      const kept = preferMergedPoLine(prev, it);
      map.set(key, computeLineEstimasi({ ...kept, qty }));
    } else {
      map.set(key, it);
    }
  }
  foldEmptySatuanMap(map, (a, b) => {
    const qty = (parseFloat(String(a.qty)) || 0) + (parseFloat(String(b.qty)) || 0);
    const kept = preferMergedPoLine(a, b);
    return computeLineEstimasi({ ...kept, qty });
  });
  return [...map.values()];
}

export function applyPoEstimasiTotals(items: PoEstimasiLine[]) {
  const enriched = (items || []).map(computeLineEstimasi);
  return { items: enriched, estimasiTotal: sumPoEstimasi(enriched) };
}
