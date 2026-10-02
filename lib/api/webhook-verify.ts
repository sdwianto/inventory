import { createHmac, timingSafeEqual } from 'crypto';
import type { Db } from 'mongodb';
import {
  findLinkForVendorCustomer,
  findLinksByWebhookSecret,
  type IntegrationLinkDoc,
} from '@/lib/api/integration-links';
import { secureCompare } from '@/lib/api/secure-compare';
import { normalizeTenantId } from '@/lib/api/tenant-scope';

export interface WebhookVerifyOk {
  ok: true;
  tenantId?: string;
  vendorTenantId?: string;
}

export interface WebhookVerifyFail {
  ok: false;
  error: string;
  status: 401 | 403;
}

export type WebhookVerifyResult = WebhookVerifyOk | WebhookVerifyFail;

export const WEBHOOK_NONCES_COLLECTION = 'webhook_nonces';
const SIGNATURE_TOLERANCE_SEC = 300;

function fail(error: string, status: 401 | 403 = 401): WebhookVerifyFail {
  return { ok: false, error, status };
}

/**
 * Secret bisa dipakai bersama beberapa vendor (data lama): vendor yang diklaim pengirim wajib salah satu
 * pemilik secret untuk customer itu, dan tanpa klaim hanya diterima bila pemiliknya tunggal.
 */
function pickLink(
  links: IntegrationLinkDoc[],
  customerTenantId: string,
  claimedVendor: string,
): { link: IntegrationLinkDoc } | WebhookVerifyFail {
  const candidates = customerTenantId
    ? links.filter((l) => normalizeTenantId(l.customerTenantId) === customerTenantId)
    : links;
  if (!candidates.length) return fail('customerTenantId tidak cocok dengan webhook secret tenant', 403);
  if (claimedVendor) {
    const match = candidates.find((l) => normalizeTenantId(l.vendorTenantId) === normalizeTenantId(claimedVendor));
    return match ? { link: match } : fail('tenantId vendor tidak cocok dengan webhook secret', 403);
  }
  if (candidates.length === 1) return { link: candidates[0] };
  return fail('Vendor wajib dikirim (X-Vendor-Tenant-Id): secret ini dipakai lebih dari satu vendor', 403);
}

/** Format Sales: `v1=hex(HMAC-SHA256(secret, "${timestamp}.${nonce}.${body}"))`. */
async function checkSignature(
  request: Request,
  db: Db | null,
  secret: string,
  rawBody: string | undefined,
): Promise<WebhookVerifyFail | null> {
  const signature = request.headers.get('x-webhook-signature');
  const timestamp = request.headers.get('x-webhook-timestamp');
  const nonce = request.headers.get('x-webhook-nonce');
  if (!signature && !timestamp && !nonce) {
    return process.env.WEBHOOK_REQUIRE_SIGNATURE === '1' ? fail('Tanda tangan webhook wajib') : null;
  }
  if (!signature || !timestamp || !nonce || rawBody === undefined) return fail('Tanda tangan webhook tidak lengkap');
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > SIGNATURE_TOLERANCE_SEC) {
    return fail('Tanda tangan webhook kedaluwarsa');
  }
  const expected = Buffer.from(`v1=${createHmac('sha256', secret).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex')}`);
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return fail('Tanda tangan webhook tidak valid');
  }
  if (db) {
    try {
      await db.collection<{ _id: string }>(WEBHOOK_NONCES_COLLECTION).insertOne({
        _id: nonce,
        expireAt: new Date(Date.now() + 2 * SIGNATURE_TOLERANCE_SEC * 1000),
      } as never);
    } catch (e) {
      if ((e as { code?: number })?.code === 11000) return fail('Nonce webhook sudah dipakai');
      throw e;
    }
  }
  return null;
}

/**
 * Identitas pengirim berasal dari integration_links (secret per pasangan customer↔vendor).
 * WEBHOOK_SECRET global hanya untuk pasangan yang belum punya link aktif — tidak bisa dipakai
 * mengatasnamakan vendor yang sudah dipasangkan.
 */
export async function verifyWebhookSecret(
  request: Request,
  db: Db | null,
  payload?: { customerTenantId?: string; vendorTenantId?: string },
  opts: { rawBody?: string } = {},
): Promise<WebhookVerifyResult> {
  const secretHeader = request.headers.get('x-webhook-secret') || '';
  const customerTenantId = normalizeTenantId(String(payload?.customerTenantId || '').trim());
  const claimedVendor = String(
    payload?.vendorTenantId || request.headers.get('x-vendor-tenant-id') || '',
  ).trim();

  let link: IntegrationLinkDoc | null = null;
  let secret = secretHeader;
  if (db) {
    if (secretHeader) {
      const links = await findLinksByWebhookSecret(db, secretHeader);
      if (links.length) {
        const picked = pickLink(links, customerTenantId, claimedVendor);
        if ('ok' in picked) return picked;
        link = picked.link;
      }
    } else if (request.headers.get('x-webhook-signature') && customerTenantId && claimedVendor) {
      link = await findLinkForVendorCustomer(db, customerTenantId, claimedVendor);
      if (link?.webhookSecret) secret = link.webhookSecret;
      else link = null;
    }
  }

  if (!link) {
    const envSecret = process.env.WEBHOOK_SECRET || '';
    if (!secretHeader) return fail('Webhook secret tidak valid');
    if (!envSecret) return fail(db ? 'Webhook secret tidak valid' : 'WEBHOOK_SECRET belum dikonfigurasi');
    if (!secureCompare(secretHeader, envSecret)) return fail('Webhook secret tidak valid');
    if (db && customerTenantId && claimedVendor && await findLinkForVendorCustomer(db, customerTenantId, claimedVendor)) {
      return fail('Vendor sudah dipasangkan: gunakan secret integrasinya, bukan WEBHOOK_SECRET global', 403);
    }
  }

  const sigFail = await checkSignature(request, db, secret, opts.rawBody);
  if (sigFail) return sigFail;

  if (!link) return { ok: true };
  return { ok: true, tenantId: link.customerTenantId, vendorTenantId: link.vendorTenantId };
}
