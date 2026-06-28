// Inventory app — handler routing (customer gudang).

import type { ApiHandler } from '@/types/api/handler';
import { handleAuth } from '@/lib/api/handlers/auth';
import { handleDashboard } from '@/lib/api/handlers/dashboard';
import { handleProducts } from '@/lib/api/handlers/products';
import { handleProductMeta } from '@/lib/api/handlers/product-meta';
import { handleInventory } from '@/lib/api/handlers/inventory';
import { handleTenants } from '@/lib/api/handlers/tenants';
import { handleUsers } from '@/lib/api/handlers/users';
import { handleWebhooks } from '@/lib/api/handlers/webhooks';
import { handleGoodsReceipts } from '@/lib/api/handlers/goods-receipts';
import { handleCatalogSync } from '@/lib/api/handlers/catalog-sync';
import { handleVendorHutang } from '@/lib/api/handlers/vendor-hutang';
import { handleProcurementExpenses } from '@/lib/api/handlers/procurement-expenses';
import { handleCustomerPo } from '@/lib/api/handlers/customer-po';
import { handleIntegrations } from '@/lib/api/handlers/integrations';
import { handleInventoryReleases } from '@/lib/api/handlers/inventory-releases';
import { handleBgJobs } from '@/lib/api/handlers/bg-jobs';
import { handleLocalPurchaseOrders } from '@/lib/api/handlers/local-purchase-orders';
import { handleAssets } from '@/lib/api/handlers/assets';
import { handleMaintenanceRequests } from '@/lib/api/handlers/maintenance-requests';
import { handleMaintenanceServiceOrders } from '@/lib/api/handlers/maintenance-service-orders';
import { handleMaintenanceSchedules } from '@/lib/api/handlers/maintenance-schedules';
import { handleMaintenanceReports } from '@/lib/api/handlers/maintenance-reports';

const SEGMENT_HANDLERS: Record<string, ApiHandler> = {
  assets: handleAssets,
  'maintenance-requests': handleMaintenanceRequests,
  'maintenance-service-orders': handleMaintenanceServiceOrders,
  'maintenance-schedules': handleMaintenanceSchedules,
  'maintenance-reports': handleMaintenanceReports,
  'local-purchase-orders': handleLocalPurchaseOrders,
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
  sync: handleCatalogSync,
  hutang: handleVendorHutang,
  'procurement-expenses': handleProcurementExpenses,
  'customer-purchase-orders': handleCustomerPo,
  'inventory-releases': handleInventoryReleases,
  tenant: handleTenants,
  tenants: handleTenants,
  users: handleUsers,
  'bg-jobs': handleBgJobs,
};

const FALLBACK: ApiHandler[] = [
  handleMaintenanceRequests,
  handleMaintenanceServiceOrders,
  handleMaintenanceSchedules,
  handleMaintenanceReports,
  handleAssets,
  handleLocalPurchaseOrders,
  handleIntegrations,
  handleWebhooks,
  handleGoodsReceipts,
  handleCatalogSync,
  handleVendorHutang,
  handleProcurementExpenses,
  handleCustomerPo,
  handleInventoryReleases,
  handleAuth,
  handleDashboard,
  handleProducts,
  handleProductMeta,
  handleInventory,
  handleTenants,
  handleUsers,
  handleBgJobs,
];

export function handlersForRoute(route: string): ApiHandler[] {
  const seg = route.split('/').filter(Boolean)[0] || '';
  const primary = SEGMENT_HANDLERS[seg];
  if (!primary) return FALLBACK;
  return [primary, ...FALLBACK.filter((h) => h !== primary)];
}
