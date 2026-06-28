import type { HandlerContext } from '@/types/api/handler';
import type { JsonObject } from '@/types/json';
import { ok, err } from '@/lib/api/db';
import { requireAuth, requireRole, PRODUCT_MANAGE_ROLES } from '@/lib/api/require-auth';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { handleIntegrations } from '@/lib/api/handlers/integrations';

export async function handleCatalogSync({
  db, route, method, body, auth,
}: HandlerContext) {
  const syncBody = (body || {}) as JsonObject;
  if (route === '/sync/vendor-catalog' && method === 'POST') {
    const denied = requireRole(auth, PRODUCT_MANAGE_ROLES);
    if (denied) return denied;

    const tenantId = String(syncBody.customerTenantId || auth?.tenantId || 'default');
    const config = await getIntegrationConfig(db, tenantId);
    const salesUrl = String(syncBody.salesAppUrl || config.salesAppUrl || '').replace(/\/$/, '');
    const apiKey = syncBody.apiKey || config.salesApiKey;
    const vendorTenantId = syncBody.vendorTenantId || config.vendorTenantId;

    if (!apiKey) {
      return err('Belum terhubung ke sales.app — jalankan pairing dari sales.app /integrasi', 400);
    }

    return handleIntegrations({
      db,
      route: '/integrations/sync-catalog',
      method: 'POST',
      body: { salesAppUrl: salesUrl, apiKey, vendorTenantId, customerTenantId: tenantId },
      auth,
      url: new URL('http://localhost/integrations/sync-catalog'),
      request: new Request('http://localhost'),
      path: ['integrations', 'sync-catalog'],
    });
  }
  return null;
}
