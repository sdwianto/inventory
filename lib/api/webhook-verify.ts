import type { Db } from 'mongodb';

interface WebhookVerifyOk {
  ok: true;
  tenantId?: string;
}

interface WebhookVerifyFail {
  ok: false;
  error: string;
}

export type WebhookVerifyResult = WebhookVerifyOk | WebhookVerifyFail;

export async function verifyWebhookSecret(request: Request, db: Db | null): Promise<WebhookVerifyResult> {
  const secret = request.headers.get('x-webhook-secret') || '';
  if (!secret) return { ok: false, error: 'Webhook secret tidak valid' };

  const envSecret = process.env.WEBHOOK_SECRET || '';
  if (envSecret && secret === envSecret) return { ok: true };

  if (db) {
    const paired = await db.collection('integration_settings').findOne({ webhookSecret: secret });
    if (paired) return { ok: true, tenantId: String(paired.tenantId || '') };
  }

  if (!envSecret) return { ok: false, error: 'WEBHOOK_SECRET belum dikonfigurasi' };
  return { ok: false, error: 'Webhook secret tidak valid' };
}
