import type { Db } from 'mongodb';
import {
  findLinksByWebhookSecret,
  resolveWebhookLink,
} from '@/lib/api/integration-links';

export interface WebhookVerifyOk {
  ok: true;
  tenantId?: string;
  vendorTenantId?: string;
}

export interface WebhookVerifyFail {
  ok: false;
  error: string;
}

export type WebhookVerifyResult = WebhookVerifyOk | WebhookVerifyFail;

export async function verifyWebhookSecret(
  request: Request,
  db: Db | null,
  payload?: { customerTenantId?: string; vendorTenantId?: string },
): Promise<WebhookVerifyResult> {
  const secret = request.headers.get('x-webhook-secret') || '';
  if (!secret) return { ok: false, error: 'Webhook secret tidak valid' };

  const envSecret = process.env.WEBHOOK_SECRET || '';
  if (envSecret && secret === envSecret) {
    return { ok: true };
  }

  if (db) {
    const customerTenantId = String(payload?.customerTenantId || '').trim().toLowerCase();
    const vendorTenantId = String(
      payload?.vendorTenantId
      || request.headers.get('x-vendor-tenant-id')
      || '',
    ).trim();

    if (customerTenantId) {
      const resolved = await resolveWebhookLink(db, secret, customerTenantId, vendorTenantId || undefined);
      if (resolved) {
        return {
          ok: true,
          tenantId: resolved.customerTenantId,
          vendorTenantId: resolved.vendorTenantId,
        };
      }
    }

    const links = await findLinksByWebhookSecret(db, secret);
    if (links.length === 1) {
      return {
        ok: true,
        tenantId: links[0].customerTenantId,
        vendorTenantId: links[0].vendorTenantId,
      };
    }
    if (links.length > 1 && customerTenantId) {
      const match = links.find((l) => l.customerTenantId === customerTenantId);
      if (match) {
        return {
          ok: true,
          tenantId: match.customerTenantId,
          vendorTenantId: match.vendorTenantId,
        };
      }
    }
  }

  if (!envSecret) return { ok: false, error: 'WEBHOOK_SECRET belum dikonfigurasi' };
  return { ok: false, error: 'Webhook secret tidak valid' };
}
