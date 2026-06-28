/** Harga referensi produk vendor — sesuai tier pelanggan di sales.app. */

const TIER_FIELDS = {
  ECER: 'hargaEcer',
  GROSIR: 'hargaGrosir',
  SPESIAL: 'hargaSpesial',
} as const;

const VENDOR_FIELDS = {
  hargaEcer: 'vendorHargaEcer',
  hargaGrosir: 'vendorHargaGrosir',
  hargaSpesial: 'vendorHargaSpesial',
} as const;

type TierKey = keyof typeof TIER_FIELDS;
type PriceField = typeof TIER_FIELDS[TierKey];

export interface VendorPriceProduct {
  vendorTenantId?: string;
  hargaEcer?: number;
  hargaGrosir?: number;
  hargaSpesial?: number;
  vendorHargaEcer?: number;
  vendorHargaGrosir?: number;
  vendorHargaSpesial?: number;
}

export function normalizeTier(tier: string | null | undefined): TierKey {
  const t = String(tier || 'ECER').toUpperCase();
  if (t in TIER_FIELDS) return t as TierKey;
  return 'ECER';
}

export function tierField(tier: string | null | undefined): PriceField {
  return TIER_FIELDS[normalizeTier(tier)];
}

export function vendorPriceFromProduct(
  product: VendorPriceProduct | null | undefined,
  tier: string | null | undefined,
): number {
  if (!product) return 0;
  const field = tierField(tier);
  const vendorField = VENDOR_FIELDS[field];
  const fromVendor = parseInt(String(product[vendorField as keyof VendorPriceProduct] || 0), 10);
  if (fromVendor > 0) return fromVendor;
  return parseInt(String(product[field] || product.hargaEcer || 0), 10);
}

export function resolveVendorTier(
  product: VendorPriceProduct | null | undefined,
  tierMap: Record<string, string> = {},
  defaultTier = 'ECER',
): TierKey {
  const vid = product?.vendorTenantId;
  if (vid && tierMap[vid]) return normalizeTier(tierMap[vid]);
  return normalizeTier(defaultTier);
}

export function vendorTierLabel(tier: string | null | undefined): string {
  const t = normalizeTier(tier);
  if (t === 'GROSIR') return 'grosir';
  if (t === 'SPESIAL') return 'spesial';
  return 'ecer';
}
