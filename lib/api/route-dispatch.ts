// Lazy route → handler (kurangi cold start Vercel).

import type { NextResponse } from 'next/server';
import type { HandlerContext } from '@/types/api/handler';

type ApiHandler = (ctx: HandlerContext) => Promise<NextResponse | null>;

const HANDLER_LOADERS: Record<string, () => Promise<ApiHandler>> = {
  sandbox: async () => (await import('@/lib/api/handlers/sandbox')).handleSandbox,
  media: async () => (await import('@/lib/api/handlers/media')).handleMedia,
  'nav-badges': async () => (await import('@/lib/api/handlers/nav-badges')).handleNavBadges,
  assets: async () => (await import('@/lib/api/handlers/assets')).handleAssets,
  'maintenance-requests': async () => (await import('@/lib/api/handlers/maintenance-requests')).handleMaintenanceRequests,
  'maintenance-service-orders': async () => (await import('@/lib/api/handlers/maintenance-service-orders')).handleMaintenanceServiceOrders,
  'maintenance-schedules': async () => (await import('@/lib/api/handlers/maintenance-schedules')).handleMaintenanceSchedules,
  'maintenance-reports': async () => (await import('@/lib/api/handlers/maintenance-reports')).handleMaintenanceReports,
  integrations: async () => (await import('@/lib/api/handlers/integrations')).handleIntegrations,
  auth: async () => (await import('@/lib/api/handlers/auth')).handleAuth,
  dashboard: async () => (await import('@/lib/api/handlers/dashboard')).handleDashboard,
  products: async () => (await import('@/lib/api/handlers/products')).handleProducts,
  'produk-grup': async () => (await import('@/lib/api/handlers/product-meta')).handleProductMeta,
  'produk-satuan': async () => (await import('@/lib/api/handlers/product-meta')).handleProductMeta,
  stok: async () => (await import('@/lib/api/handlers/inventory')).handleInventory,
  lokasi: async () => (await import('@/lib/api/handlers/inventory')).handleInventory,
  webhooks: async () => (await import('@/lib/api/handlers/webhooks')).handleWebhooks,
  'goods-receipts': async () => (await import('@/lib/api/handlers/goods-receipts')).handleGoodsReceipts,
  sync: async () => (await import('@/lib/api/handlers/catalog-sync')).handleCatalogSync,
  hutang: async () => (await import('@/lib/api/handlers/vendor-hutang')).handleVendorHutang,
  'procurement-expenses': async () => (await import('@/lib/api/handlers/procurement-expenses')).handleProcurementExpenses,
  'customer-purchase-orders': async () => (await import('@/lib/api/handlers/customer-po')).handleCustomerPo,
  'inventory-releases': async () => (await import('@/lib/api/handlers/inventory-releases')).handleInventoryReleases,
  tenant: async () => (await import('@/lib/api/handlers/tenants')).handleTenants,
  tenants: async () => (await import('@/lib/api/handlers/tenants')).handleTenants,
  users: async () => (await import('@/lib/api/handlers/users')).handleUsers,
  'bg-jobs': async () => (await import('@/lib/api/handlers/bg-jobs')).handleBgJobs,
  ops: async () => (await import('@/lib/api/handlers/ops-dashboard')).handleOpsDashboard,
  workspace: async () => (await import('@/lib/api/handlers/workspace')).handleWorkspace,
  'audit-log': async () => (await import('@/lib/api/handlers/audit')).handleAudit,
  pages: async () => (await import('@/lib/api/handlers/pages')).handlePages,
};

export async function dispatchRoute(ctx: HandlerContext): Promise<NextResponse | null> {
  const seg = ctx.route.split('/').filter(Boolean)[0] || '';
  const loader = HANDLER_LOADERS[seg];
  if (!loader) return null;
  const handler = await loader();
  return handler(ctx);
}

/** @deprecated */
export function handlersForRoute(route: string): ApiHandler[] {
  void route;
  return [];
}
