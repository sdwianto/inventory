interface VendorProduct {
  vendorTenantName?: string;
  vendorTenantId?: string;
}

export function vendorDisplayName(product: VendorProduct | null | undefined): string {
  if (!product) return '';
  const name = product.vendorTenantName;
  if (name && name !== product.vendorTenantId) return name;
  return name || product.vendorTenantId || '';
}
