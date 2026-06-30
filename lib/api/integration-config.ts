/** Konfigurasi integrasi sales.app — DB (pairing) dengan fallback .env */

import type { Db } from 'mongodb';
import { normalizeTenantId } from '@/lib/api/tenant-scope';

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
}

export async function getIntegrationConfig(db: Db, tenantId: string | null | undefined): Promise<IntegrationConfig> {
  const tid = normalizeTenantId(tenantId || 'default');
  const dbConfig = tid
    ? await db.collection('integration_settings').findOne({ tenantId: tid })
    : null;

  return {
    salesAppUrl: (String(dbConfig?.salesAppUrl || process.env.SALES_APP_URL || 'http://localhost:3000')).replace(/\/$/, ''),
    salesApiKey: String(dbConfig?.salesApiKey || process.env.SALES_API_KEY || ''),
    vendorTenantId: String(dbConfig?.vendorTenantId || process.env.SALES_VENDOR_TENANT_ID || 'default'),
    webhookSecret: String(dbConfig?.webhookSecret || process.env.WEBHOOK_SECRET || ''),
    vendorName: String(dbConfig?.vendorName || ''),
    tierHargaDefault: String(dbConfig?.tierHargaDefault || 'ECER'),
    pairedAt: (dbConfig?.pairedAt as Date | string | null) || null,
    lastCatalogSyncAt: (dbConfig?.lastCatalogSyncAt as Date | string | null) || null,
    customerTenantId: String(dbConfig?.customerTenantId || tid),
    source: dbConfig ? 'database' : (process.env.SALES_API_KEY ? 'env' : 'none'),
  };
}

export function getSetupToken(): string | null {
  const configured = (process.env.INTEGRATION_SETUP_TOKEN || '').trim();
  if (configured) return configured;
  // Production wajib token eksplisit; jangan pernah pakai default (fail closed).
  if (process.env.NODE_ENV === 'production') return null;
  return 'dev_pair_token_local_only';
}
