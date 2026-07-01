/** Registry relasi B2B multi-vendor × multi-customer (sisi inventory). */

import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { normalizeTenantId } from '@/lib/api/tenant-scope';

export interface IntegrationLinkDoc {
  id: string;
  customerTenantId: string;
  vendorTenantId: string;
  salesAppUrl: string;
  salesApiKey: string;
  webhookSecret: string;
  vendorName: string;
  tierHargaDefault: string;
  status: 'ACTIVE' | 'INACTIVE';
  pairedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertIntegrationLinkInput {
  customerTenantId: string;
  vendorTenantId: string;
  salesAppUrl: string;
  salesApiKey: string;
  webhookSecret: string;
  vendorName?: string;
  tierHargaDefault?: string;
}

function linkKey(customerTenantId: string, vendorTenantId: string) {
  return {
    customerTenantId: normalizeTenantId(customerTenantId),
    vendorTenantId: String(vendorTenantId || '').trim(),
  };
}

export async function upsertIntegrationLink(
  db: Db,
  input: UpsertIntegrationLinkInput,
): Promise<IntegrationLinkDoc> {
  const keys = linkKey(input.customerTenantId, input.vendorTenantId);
  if (!keys.customerTenantId || !keys.vendorTenantId) {
    throw new Error('customerTenantId dan vendorTenantId wajib');
  }

  const now = new Date();
  const existing = await db.collection('integration_links').findOne(keys);
  const doc: IntegrationLinkDoc = {
    id: String(existing?.id || uuidv4()),
    customerTenantId: keys.customerTenantId,
    vendorTenantId: keys.vendorTenantId,
    salesAppUrl: String(input.salesAppUrl || '').replace(/\/$/, ''),
    salesApiKey: String(input.salesApiKey || '').trim(),
    webhookSecret: String(input.webhookSecret || '').trim(),
    vendorName: String(input.vendorName || keys.vendorTenantId).trim(),
    tierHargaDefault: String(input.tierHargaDefault || 'ECER').toUpperCase(),
    status: 'ACTIVE',
    pairedAt: (existing?.pairedAt as Date) || now,
    createdAt: (existing?.createdAt as Date) || now,
    updatedAt: now,
  };

  const { createdAt: _createdAt, ...setFields } = doc;
  await db.collection('integration_links').updateOne(
    keys,
    { $set: setFields, $setOnInsert: { createdAt: (existing?.createdAt as Date) || now } },
    { upsert: true },
  );

  await syncCustomerIntegrationSettings(db, keys.customerTenantId);
  return doc;
}

/** Ringkasan per customer — backward compat dengan integration_settings. */
export async function syncCustomerIntegrationSettings(db: Db, customerTenantId: string): Promise<void> {
  const tid = normalizeTenantId(customerTenantId);
  const links = await listActiveLinksForCustomer(db, tid);
  const now = new Date();

  if (!links.length) return;

  const primary = links[0];
  const legacy = await db.collection('integration_settings').findOne({ tenantId: tid });
  const salesApiKey = String(
    process.env.SALES_PLATFORM_API_KEY
    || legacy?.salesApiKey
    || primary.salesApiKey
    || '',
  ).trim();

  await db.collection('integration_settings').updateOne(
    { tenantId: tid },
    {
      $set: {
        tenantId: tid,
        customerTenantId: tid,
        salesAppUrl: primary.salesAppUrl,
        salesApiKey,
        vendorTenantId: primary.vendorTenantId,
        webhookSecret: primary.webhookSecret,
        vendorName: primary.vendorName,
        tierHargaDefault: primary.tierHargaDefault,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

export async function migrateLegacyIntegrationSettings(db: Db): Promise<number> {
  const rows = await db.collection('integration_settings').find({}).toArray();
  let migrated = 0;
  for (const row of rows) {
    const customerTenantId = normalizeTenantId(String(row.tenantId || row.customerTenantId || ''));
    const vendorTenantId = String(row.vendorTenantId || '').trim();
    if (!customerTenantId || !vendorTenantId) continue;
    const exists = await db.collection('integration_links').findOne({
      customerTenantId,
      vendorTenantId,
    });
    if (exists) continue;
    await upsertIntegrationLink(db, {
      customerTenantId,
      vendorTenantId,
      salesAppUrl: String(row.salesAppUrl || process.env.SALES_APP_URL || ''),
      salesApiKey: String(row.salesApiKey || ''),
      webhookSecret: String(row.webhookSecret || ''),
      vendorName: String(row.vendorName || vendorTenantId),
      tierHargaDefault: String(row.tierHargaDefault || 'ECER'),
    });
    migrated += 1;
  }
  return migrated;
}

export async function listActiveLinksForCustomer(db: Db, customerTenantId: string): Promise<IntegrationLinkDoc[]> {
  const tid = normalizeTenantId(customerTenantId);
  return db.collection<IntegrationLinkDoc>('integration_links')
    .find({ customerTenantId: tid, status: 'ACTIVE' })
    .sort({ pairedAt: -1 })
    .toArray();
}

export async function findLinkForVendorCustomer(
  db: Db,
  customerTenantId: string,
  vendorTenantId: string,
): Promise<IntegrationLinkDoc | null> {
  const keys = linkKey(customerTenantId, vendorTenantId);
  return db.collection<IntegrationLinkDoc>('integration_links').findOne({
    ...keys,
    status: 'ACTIVE',
  });
}

export async function findLinksByWebhookSecret(
  db: Db,
  secret: string,
): Promise<IntegrationLinkDoc[]> {
  const s = String(secret || '').trim();
  if (!s) return [];
  return db.collection<IntegrationLinkDoc>('integration_links')
    .find({ webhookSecret: s, status: 'ACTIVE' })
    .toArray();
}

export async function resolveWebhookLink(
  db: Db,
  secret: string,
  customerTenantId: string,
  vendorTenantId?: string,
): Promise<IntegrationLinkDoc | null> {
  const ctid = normalizeTenantId(customerTenantId);
  const links = await findLinksByWebhookSecret(db, secret);
  if (!links.length) return null;

  const vid = String(vendorTenantId || '').trim();
  if (vid) {
    const exact = links.find((l) => l.customerTenantId === ctid && l.vendorTenantId === vid);
    if (exact) return exact;
  }
  const forCustomer = links.filter((l) => l.customerTenantId === ctid);
  if (forCustomer.length === 1) return forCustomer[0];
  if (vid) return forCustomer.find((l) => l.vendorTenantId === vid) || null;
  return forCustomer[0] || null;
}

export function resolvePlatformSalesApiKey(): string {
  return String(process.env.SALES_PLATFORM_API_KEY || '').trim();
}

export async function getSalesApiKeyForVendor(
  db: Db,
  customerTenantId: string,
  vendorTenantId?: string,
): Promise<string> {
  const platform = resolvePlatformSalesApiKey();
  if (platform) return platform;

  const tid = normalizeTenantId(customerTenantId);
  const vid = String(vendorTenantId || '').trim();
  if (vid) {
    const link = await findLinkForVendorCustomer(db, tid, vid);
    if (link?.salesApiKey) return link.salesApiKey;
  }

  const links = await listActiveLinksForCustomer(db, tid);
  for (const link of links) {
    if (link.salesApiKey) return link.salesApiKey;
  }

  const legacy = await db.collection('integration_settings').findOne({ tenantId: tid });
  return String(legacy?.salesApiKey || process.env.SALES_API_KEY || '').trim();
}

export async function resolveSalesApiAccess(
  db: Db,
  customerTenantId: string,
  vendorTenantId?: string,
): Promise<{ salesAppUrl: string; salesApiKey: string } | null> {
  const salesApiKey = await getSalesApiKeyForVendor(db, customerTenantId, vendorTenantId);
  if (!salesApiKey) return null;

  const tid = normalizeTenantId(customerTenantId);
  const vid = String(vendorTenantId || '').trim();
  const link = vid ? await findLinkForVendorCustomer(db, tid, vid) : null;
  const links = link ? [link] : await listActiveLinksForCustomer(db, tid);
  const legacy = await db.collection('integration_settings').findOne({ tenantId: tid });

  const salesAppUrl = String(
    link?.salesAppUrl
    || links[0]?.salesAppUrl
    || legacy?.salesAppUrl
    || process.env.SALES_APP_URL
    || 'http://localhost:3000',
  ).replace(/\/$/, '');

  return { salesAppUrl, salesApiKey };
}
