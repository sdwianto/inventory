/** Default estimasi harga PO = harga beli terakhir + 10% (buffer). */

import {
  resolveVendorTier,
  vendorPriceFromProduct,
} from '@/lib/vendor-price';

export function defaultEstimasiHarga(hargaBeli) {
  const beli = parseInt(hargaBeli || 0, 10);
  if (beli <= 0) return 0;
  return Math.round(beli * 1.1);
}

/** Estimasi baris PO — harga vendor sesuai tier pelanggan (ecer/grosir/spesial). */
export function poEstimasiFromProduct(product, tierMap = {}, defaultTier = 'ECER') {
  if (!product) return 0;
  if (product.syncSource === 'sales.app') {
    const tier = resolveVendorTier(product, tierMap, defaultTier);
    return vendorPriceFromProduct(product, tier) || 0;
  }
  return defaultEstimasiHarga(product.hargaBeli);
}
export function parseEstimasiHargaInput(value) {
  const n = parseInt(String(value ?? '').replace(/\D/g, ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
