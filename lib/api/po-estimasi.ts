// Hitung estimasi belanja dari baris PO customer.

export function computeLineEstimasi(it) {
  const qty = parseFloat(it.qty) || 0;
  const estimasiHarga = parseInt(it.estimasiHarga || it.hargaBeliReferensi || 0, 10);
  const estimasiJumlah = Math.round(qty * estimasiHarga);
  return { ...it, qty, estimasiHarga, estimasiJumlah };
}

export function sumPoEstimasi(items) {
  return (items || []).reduce((s, it) => s + (it.estimasiJumlah || 0), 0);
}

/** Gabung baris PO dengan produk + satuan yang sama. */
export function mergePoItemsByStokId(items) {
  const map = new Map();
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
        qty: (parseFloat(prev.qty) || 0) + (parseFloat(it.qty) || 0),
      }));
    } else {
      map.set(key, it);
    }
  }
  return [...map.values()];
}

export function applyPoEstimasiTotals(items) {
  const enriched = (items || []).map(computeLineEstimasi);
  return { items: enriched, estimasiTotal: sumPoEstimasi(enriched) };
}
