// Inventory app — handler routing (customer gudang).

import { handleAuth } from '@/lib/api/handlers/auth';
import { handleDashboard } from '@/lib/api/handlers/dashboard';
import { handleProducts } from '@/lib/api/handlers/products';
import { handleProductMeta } from '@/lib/api/handlers/product-meta';
import { handleInventory } from '@/lib/api/handlers/inventory';
import { handleTenants } from '@/lib/api/handlers/tenants';
import { handleUsers } from '@/lib/api/handlers/users';
import { handleWebhooks } from '@/lib/api/handlers/webhooks';
import { handleGoodsReceipts } from '@/lib/api/handlers/goods-receipts';
import { handleVendorMap } from '@/lib/api/handlers/vendor-map';
import { handleCatalogSync } from '@/lib/api/handlers/catalog-sync';
import { handleVendorHutang } from '@/lib/api/handlers/vendor-hutang';
import { handleCustomerPo } from '@/lib/api/handlers/customer-po';
import { handleIntegrations } from '@/lib/api/handlers/integrations';

const SEGMENT_HANDLERS = {
  integrations: handleIntegrations,
  auth: handleAuth,
  dashboard: handleDashboard,
  products: handleProducts,
  'produk-grup': handleProductMeta,
  'produk-satuan': handleProductMeta,
  stok: handleInventory,
  lokasi: handleInventory,
  webhooks: handleWebhooks,
  'goods-receipts': handleGoodsReceipts,
  'vendor-product-map': handleVendorMap,
  sync: handleCatalogSync,
  hutang: handleVendorHutang,
  'customer-purchase-orders': handleCustomerPo,
  tenant: handleTenants,
  tenants: handleTenants,
  users: handleUsers,
};

const FALLBACK = [
  handleIntegrations,
  handleWebhooks,
  handleGoodsReceipts,
  handleVendorMap,
  handleCatalogSync,
  handleVendorHutang,
  handleCustomerPo,
  handleAuth,
  handleDashboard,
  handleProducts,
  handleProductMeta,
  handleInventory,
  handleTenants,
  handleUsers,
];

export function handlersForRoute(route) {
  const seg = route.split('/').filter(Boolean)[0] || '';
  const primary = SEGMENT_HANDLERS[seg];
  if (!primary) return FALLBACK;
  return [primary, ...FALLBACK.filter((h) => h !== primary)];
}
