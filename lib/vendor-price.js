/** Harga referensi produk vendor — sesuai tier pelanggan di sales.app. */

const TIER_FIELDS = {
  ECER: 'hargaEcer',
  GROSIR: 'hargaGrosir',
  SPESIAL: 'hargaSpesial',
};

const VENDOR_FIELDS = {
  hargaEcer: 'vendorHargaEcer',
  hargaGrosir: 'vendorHargaGrosir',
  hargaSpesial: 'vendorHargaSpesial',
};

export function normalizeTier(tier) {
  return String(tier || 'ECER').toUpperCase();
}

export function tierField(tier) {
  return TIER_FIELDS[normalizeTier(tier)] || 'hargaEcer';
}

export function vendorPriceFromProduct(product, tier) {
  if (!product) return 0;
  const field = tierField(tier);
  const vendorField = VENDOR_FIELDS[field] || 'vendorHargaEcer';
  const fromVendor = parseInt(product[vendorField] || 0, 10);
  if (fromVendor > 0) return fromVendor;
  return parseInt(product[field] || product.hargaEcer || 0, 10);
}

export function resolveVendorTier(product, tierMap = {}, defaultTier = 'ECER') {
  const vid = product?.vendorTenantId;
  if (vid && tierMap[vid]) return normalizeTier(tierMap[vid]);
  return normalizeTier(defaultTier);
}

export function vendorTierLabel(tier) {
  const t = normalizeTier(tier);
  if (t === 'GROSIR') return 'grosir';
  if (t === 'SPESIAL') return 'spesial';
  return 'ecer';
}
