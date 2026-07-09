// Hitung estimasi belanja dari baris PO customer.

export type PoEstimasiLine = Record<string, unknown> & {
  qty?: number | string;
  estimasiHarga?: number | string;
  hargaBeliReferensi?: number | string;
  estimasiJumlah?: number;
  localStokId?: string;
  vendorTenantId?: string;
  vendorKode?: string;
  kode?: string;
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

/** Gabung baris PO dengan produk + satuan yang sama. */
export function mergePoItemsByStokId(items: PoEstimasiLine[]) {
  const map = new Map<string, ReturnType<typeof computeLineEstimasi>>();
  for (const raw of items || []) {
    const it = computeLineEstimasi(raw);
    const baseKey = it.localStokId || `${it.vendorTenantId || ''}:${it.vendorKode || it.kode || ''}`;
    const key = it.localStokId
      ? `${baseKey}::${it.uomId || ''}`
      : baseKey;
    if (!key || key === ':') continue;
    const prev = map.get(key);
    if (prev) {
      map.set(key, computeLineEstimasi({
        ...prev,
        qty: (parseFloat(String(prev.qty)) || 0) + (parseFloat(String(it.qty)) || 0),
      }));
    } else {
      map.set(key, it);
    }
  }
  return [...map.values()];
}

export function applyPoEstimasiTotals(items: PoEstimasiLine[]) {
  const enriched = (items || []).map(computeLineEstimasi);
  return { items: enriched, estimasiTotal: sumPoEstimasi(enriched) };
}
