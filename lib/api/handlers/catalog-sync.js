// Pull katalog produk dari sales.app (initial / manual sync).

import { ok, err } from '@/lib/api/db';
import { requireAuth } from '@/lib/api/require-auth';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { handleIntegrations } from '@/lib/api/handlers/integrations';

export async function handleCatalogSync({ db, route, method, body, auth }) {
  if (route === '/sync/vendor-catalog' && method === 'POST') {
    const denied = requireAuth(auth);
    if (denied) return denied;

    const tenantId = body?.customerTenantId || auth?.tenantId || 'default';
    const config = await getIntegrationConfig(db, tenantId);
    const salesUrl = (body?.salesAppUrl || config.salesAppUrl).replace(/\/$/, '');
    const apiKey = body?.apiKey || config.salesApiKey;
    const vendorTenantId = body?.vendorTenantId || config.vendorTenantId;

    if (!apiKey) {
      return err('Belum terhubung ke sales.app — jalankan pairing dari sales.app /integrasi', 400);
    }

    return handleIntegrations({
      db,
      route: '/integrations/sync-catalog',
      method: 'POST',
      body: { salesAppUrl: salesUrl, apiKey, vendorTenantId, customerTenantId: tenantId },
      auth,
    });
  }
  return null;
}
