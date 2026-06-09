// Inventory cost helpers — weighted average harga beli (moving average).

/** Normalisasi angka dari MongoDB / form (string, int, float). */
export function toQty(val, fallback = 0) {
  if (val == null || val === '') return fallback;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return Number.isFinite(n) ? n : fallback;
}

export function toHarga(val, fallback = 0) {
  if (val == null || val === '') return fallback;
  const n = typeof val === 'number' ? val : parseInt(String(val), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Harga per unit setelah diskon baris pembelian. */
export function effectiveUnitCost(qty, harga, diskon = 0) {
  const q = toQty(qty);
  if (q <= 0) return 0;
  const lineTotal = toHarga(harga) * q - toHarga(diskon);
  return Math.max(0, Math.round(lineTotal / q));
}

/**
 * Rata-rata tertimbang: (stokLama × hargaLama + qtyMasuk × hargaMasuk) / (stokLama + qtyMasuk)
 * Jika stok lama <= 0, gunakan harga masuk saja.
 */
export function calcWeightedAvgHargaBeli(oldQty, oldHarga, newQty, newUnitCost) {
  const stokLama = toQty(oldQty);
  const hargaLama = toHarga(oldHarga);
  const qtyMasuk = toQty(newQty);
  const hargaMasuk = toHarga(newUnitCost);

  if (qtyMasuk <= 0) return hargaLama;
  if (stokLama <= 0) return hargaMasuk;

  const totalQty = stokLama + qtyMasuk;
  const weighted = (stokLama * hargaLama + qtyMasuk * hargaMasuk) / totalQty;
  return Math.round(weighted);
}

/** Pertahankan margin % harga jual saat harga beli berubah. */
export function repriceFromMargin(oldBeli, newBeli, oldPrice) {
  const beliLama = toHarga(oldBeli);
  const beliBaru = toHarga(newBeli);
  const harga = toHarga(oldPrice);
  if (harga <= 0 || beliBaru <= 0 || beliLama <= 0 || beliBaru === beliLama) return harga;
  const margin = (harga - beliLama) / beliLama;
  return Math.max(0, Math.round(beliBaru * (1 + margin)));
}

/** Sesuaikan harga spesial/grosir/ecer setelah harga beli baru dari pembelian. */
export function buildJualPricesAfterBeliChange(oldBeli, newBeli, prod = {}) {
  const out = {};
  if (toHarga(prod.hargaSpesial) > 0) {
    out.hargaSpesial = repriceFromMargin(oldBeli, newBeli, prod.hargaSpesial);
  }
  if (toHarga(prod.hargaGrosir) > 0) {
    out.hargaGrosir = repriceFromMargin(oldBeli, newBeli, prod.hargaGrosir);
  }
  if (toHarga(prod.hargaEcer) > 0) {
    out.hargaEcer = repriceFromMargin(oldBeli, newBeli, prod.hargaEcer);
  }
  return out;
}
