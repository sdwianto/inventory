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
  kitchens: async () => (await import('@/lib/api/handlers/kitchens')).handleKitchens,
  'service-points': async () => (await import('@/lib/api/handlers/service-points')).handleServicePoints,
  armadas: async () => (await import('@/lib/api/handlers/armadas')).handleArmadas,
  'distribution-orders': async () => (await import('@/lib/api/handlers/distribution-orders')).handleDistributionOrders,
  'temperature-logs': async () => (await import('@/lib/api/handlers/temperature-logs')).handleTemperatureLogs,
  'temperature-thresholds': async () => (await import('@/lib/api/handlers/temperature-logs')).handleTemperatureLogs,
  'haccp-templates': async () => (await import('@/lib/api/handlers/haccp')).handleHaccp,
  'haccp-results': async () => (await import('@/lib/api/handlers/haccp')).handleHaccp,
  'haccp-plans': async () => (await import('@/lib/api/handlers/haccp-plans')).handleHaccpPlans,
  'haccp-verifications': async () => (await import('@/lib/api/handlers/haccp-verifications')).handleHaccpVerifications,
  'supplier-price-book': async () => (await import('@/lib/api/handlers/supplier-price-book')).handleSupplierPriceBook,
  recipes: async () => (await import('@/lib/api/handlers/recipes')).handleRecipes,
  'recipe-portion-exceptions': async () => (
    await import('@/lib/api/handlers/recipe-portion-exceptions')
  ).handleRecipePortionExceptions,
  menus: async () => (await import('@/lib/api/handlers/menus')).handleMenus,
  'production-plans': async () => (await import('@/lib/api/handlers/production-plans')).handleProductionPlans,
  'portion-targets': async () => (await import('@/lib/api/handlers/portion-targets')).handlePortionTargets,
  'material-requirements': async () => (await import('@/lib/api/handlers/material-requirements')).handleMaterialRequirements,
  'purchase-requirements': async () => (await import('@/lib/api/handlers/purchase-requirements')).handlePurchaseRequirements,
  'material-issues': async () => (await import('@/lib/api/handlers/material-issues')).handleMaterialIssues,
  'production-results': async () => (await import('@/lib/api/handlers/production-results')).handleProductionResults,
  'production-reports': async () => (await import('@/lib/api/handlers/production-reports')).handleProductionReports,
  'nutrition-profiles': async () => (await import('@/lib/api/handlers/nutrition-profiles')).handleNutritionProfiles,
  'food-costs': async () => (await import('@/lib/api/handlers/food-costs')).handleFoodCosts,
  'qc-templates': async () => (await import('@/lib/api/handlers/qc')).handleQc,
  'qc-results': async () => (await import('@/lib/api/handlers/qc')).handleQc,
  'food-safety-programs': async () => (await import('@/lib/api/handlers/food-safety-programs')).handleFoodSafetyPrograms,
  'food-safety-requirements': async () => (await import('@/lib/api/handlers/food-safety-programs')).handleFoodSafetyPrograms,
  'food-safety-readiness': async () => (await import('@/lib/api/handlers/food-safety-audit')).handleFoodSafetyAudit,
  'food-safety-traceability': async () => (await import('@/lib/api/handlers/food-safety-audit')).handleFoodSafetyAudit,
  'ka-policies': async () => (await import('@/lib/api/handlers/kitchen-assurance')).handleKitchenAssurance,
  'ka-monitoring': async () => (await import('@/lib/api/handlers/kitchen-assurance')).handleKitchenAssurance,
  'ka-observations': async () => (await import('@/lib/api/handlers/kitchen-assurance')).handleKitchenAssurance,
  'ka-safety-cases': async () => (await import('@/lib/api/handlers/kitchen-assurance')).handleKitchenAssurance,
  'ka-follow-ups': async () => (await import('@/lib/api/handlers/kitchen-assurance')).handleKitchenAssurance,
  'ka-dashboard': async () => (await import('@/lib/api/handlers/kitchen-assurance')).handleKitchenAssurance,
  'ka-reports': async () => (await import('@/lib/api/handlers/kitchen-assurance')).handleKitchenAssurance,
  'ka-analytics': async () => (await import('@/lib/api/handlers/kitchen-assurance')).handleKitchenAssurance,
  'food-forecasts': async () => (await import('@/lib/api/handlers/food-forecasts')).handleFoodForecasts,
  'food-dashboard': async () => (await import('@/lib/api/handlers/food-dashboard')).handleFoodDashboard,
  'food-recommendations': async () => (await import('@/lib/api/handlers/food-recommendations')).handleFoodRecommendations,
  'kitchen-transfers': async () => (await import('@/lib/api/handlers/kitchen-transfers')).handleKitchenTransfers,
  'production-calendar': async () => (await import('@/lib/api/handlers/production-calendar')).handleProductionCalendar,
  'production-batches': async () => (await import('@/lib/api/handlers/production-batches')).handleProductionBatches,
  'fp-public': async () => (await import('@/lib/api/handlers/fp-public')).handleFpPublic,
  'api-keys': async () => (await import('@/lib/api/handlers/api-keys')).handleApiKeys,
  'produk-grup': async () => (await import('@/lib/api/handlers/product-meta')).handleProductMeta,
  'produk-satuan': async () => (await import('@/lib/api/handlers/product-meta')).handleProductMeta,
  stok: async () => (await import('@/lib/api/handlers/inventory')).handleInventory,
  lokasi: async () => (await import('@/lib/api/handlers/inventory')).handleInventory,
  'warehouse-bins': async () => (await import('@/lib/api/handlers/warehouse-bins')).handleWarehouseBins,
  'stok-bin': async () => (await import('@/lib/api/handlers/stok-bin')).handleStokBin,
  'putaway-moves': async () => (await import('@/lib/api/handlers/putaway-moves')).handlePutawayMoves,
  webhooks: async () => (await import('@/lib/api/handlers/webhooks')).handleWebhooks,
  'goods-receipts': async () => (await import('@/lib/api/handlers/goods-receipts')).handleGoodsReceipts,
  sync: async () => (await import('@/lib/api/handlers/catalog-sync')).handleCatalogSync,
  hutang: async () => (await import('@/lib/api/handlers/vendor-hutang')).handleVendorHutang,
  'vendor-returns': async () => (await import('@/lib/api/handlers/vendor-returns')).handleVendorReturns,
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

/** First path segment after /api (e.g. `/fp-public/plans` → `fp-public`). */
export function routeRootSegment(route: string): string {
  return route.split('/').filter(Boolean)[0] || '';
}

/**
 * API keys may only hit fp-public. Session auth unrestricted here.
 * Exported for unit tests / defense-in-depth checks.
 */
export function apiKeyRouteDenied(
  isApiKey: boolean | undefined,
  route: string,
): boolean {
  return Boolean(isApiKey) && routeRootSegment(route) !== 'fp-public';
}

/** Strip /v1 prefix so /api/v1/integrations/* hits same handlers as /api/integrations/*. */
export function normalizeApiRoute(route: string): string {
  const r = String(route || '');
  if (r === '/v1' || r.startsWith('/v1/')) {
    const rest = r.slice(3) || '/';
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return r;
}

export async function dispatchRoute(ctx: HandlerContext): Promise<NextResponse | null> {
  const normalizedRoute = normalizeApiRoute(ctx.route);
  const normalizedCtx = normalizedRoute === ctx.route
    ? ctx
    : { ...ctx, route: normalizedRoute, path: normalizedRoute.split('/').filter(Boolean) };

  if (apiKeyRouteDenied(normalizedCtx.auth?.isApiKey, normalizedCtx.route)) {
    const { err } = await import('@/lib/api/db');
    return err('API key hanya diizinkan pada /api/fp-public/*', 403);
  }
  const seg = routeRootSegment(normalizedCtx.route);
  const loader = HANDLER_LOADERS[seg];
  if (!loader) return null;
  const handler = await loader();
  return handler(normalizedCtx);
}

/** @deprecated */
export function handlersForRoute(route: string): ApiHandler[] {
  void route;
  return [];
}
