/** Default estimasi harga PO = harga beli terakhir + 10% (buffer). */

export function defaultEstimasiHarga(hargaBeli) {
  const beli = parseInt(hargaBeli || 0, 10);
  if (beli <= 0) return 0;
  return Math.round(beli * 1.1);
}

export function parseEstimasiHargaInput(value) {
  const n = parseInt(String(value ?? '').replace(/\D/g, ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
