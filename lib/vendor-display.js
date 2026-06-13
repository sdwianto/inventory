export function vendorDisplayName(product) {
  if (!product) return '';
  const name = product.vendorTenantName;
  if (name && name !== product.vendorTenantId) return name;
  return name || product.vendorTenantId || '';
}
