/** Konfigurasi integrasi sales.app — DB (pairing) dengan fallback .env */

export async function getIntegrationConfig(db, tenantId) {
  const tid = (tenantId || 'default').trim();
  const dbConfig = tid
    ? await db.collection('integration_settings').findOne({ tenantId: tid })
    : null;

  return {
    salesAppUrl: (dbConfig?.salesAppUrl || process.env.SALES_APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
    salesApiKey: dbConfig?.salesApiKey || process.env.SALES_API_KEY || '',
    vendorTenantId: dbConfig?.vendorTenantId || process.env.SALES_VENDOR_TENANT_ID || 'default',
    webhookSecret: dbConfig?.webhookSecret || process.env.WEBHOOK_SECRET || '',
    vendorName: dbConfig?.vendorName || '',
    pairedAt: dbConfig?.pairedAt || null,
    customerTenantId: dbConfig?.customerTenantId || tid,
    source: dbConfig ? 'database' : (process.env.SALES_API_KEY ? 'env' : 'none'),
  };
}

export function getSetupToken() {
  return process.env.INTEGRATION_SETUP_TOKEN || 'dev_pair_token_local_only';
}
