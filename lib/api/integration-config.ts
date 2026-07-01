/** Konfigurasi integrasi sales.app — DB links + fallback legacy .env */

import type { Db } from 'mongodb';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import {
  getSalesApiKeyForVendor,
  listActiveLinksForCustomer,
  migrateLegacyIntegrationSettings,
  resolvePlatformSalesApiKey,
} from '@/lib/api/integration-links';

export interface IntegrationConfig {
  salesAppUrl: string;
  salesApiKey: string;
  vendorTenantId: string;
  webhookSecret: string;
  vendorName: string;
  tierHargaDefault: string;
  pairedAt: Date | string | null;
  lastCatalogSyncAt: Date | string | null;
  customerTenantId: string;
  source: 'database' | 'env' | 'none';
  vendorLinks: Array<{
    vendorTenantId: string;
    vendorName: string;
    tierHargaDefault: string;
    pairedAt: Date | string | null;
  }>;
}

let legacyMigrationDone = false;

async function ensureLinksMigrated(db: Db): Promise<void> {
  if (legacyMigrationDone) return;
  await migrateLegacyIntegrationSettings(db);
  legacyMigrationDone = true;
}

export async function getIntegrationConfig(
  db: Db,
  tenantId: string | null | undefined,
  vendorTenantId?: string,
): Promise<IntegrationConfig> {
  const tid = normalizeTenantId(tenantId || 'default');
  await ensureLinksMigrated(db);

  const dbConfig = tid
    ? await db.collection('integration_settings').findOne({ tenantId: tid })
    : null;
  const links = tid ? await listActiveLinksForCustomer(db, tid) : [];
  const vid = String(vendorTenantId || dbConfig?.vendorTenantId || links[0]?.vendorTenantId || '').trim();
  const linkForVendor = vid
    ? links.find((l) => l.vendorTenantId === vid) || null
    : links[0] || null;

  const salesApiKey = await getSalesApiKeyForVendor(db, tid, vid || undefined);

  return {
    salesAppUrl: (String(
      linkForVendor?.salesAppUrl
      || dbConfig?.salesAppUrl
      || process.env.SALES_APP_URL
      || 'http://localhost:3000',
    )).replace(/\/$/, ''),
    salesApiKey,
    vendorTenantId: vid || String(process.env.SALES_VENDOR_TENANT_ID || 'default'),
    webhookSecret: String(
      linkForVendor?.webhookSecret
      || dbConfig?.webhookSecret
      || process.env.WEBHOOK_SECRET
      || '',
    ),
    vendorName: String(linkForVendor?.vendorName || dbConfig?.vendorName || ''),
    tierHargaDefault: String(linkForVendor?.tierHargaDefault || dbConfig?.tierHargaDefault || 'ECER'),
    pairedAt: (linkForVendor?.pairedAt || dbConfig?.pairedAt || null) as Date | string | null,
    lastCatalogSyncAt: (dbConfig?.lastCatalogSyncAt as Date | string | null) || null,
    customerTenantId: String(dbConfig?.customerTenantId || tid),
    source: links.length || dbConfig
      ? 'database'
      : (process.env.SALES_API_KEY || resolvePlatformSalesApiKey() ? 'env' : 'none'),
    vendorLinks: links.map((l) => ({
      vendorTenantId: l.vendorTenantId,
      vendorName: l.vendorName,
      tierHargaDefault: l.tierHargaDefault,
      pairedAt: l.pairedAt,
    })),
  };
}

export function getSetupToken(): string | null {
  const configured = (process.env.INTEGRATION_SETUP_TOKEN || '').trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return null;
  return 'dev_pair_token_local_only';
}
