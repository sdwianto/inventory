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

export function applyPoEstimasiTotals(items) {
  const enriched = (items || []).map(computeLineEstimasi);
  return { items: enriched, estimasiTotal: sumPoEstimasi(enriched) };
}
