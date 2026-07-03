import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhookSecret } from '@/lib/api/webhook-verify';

function req(secret: string): Request {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'x-webhook-secret' ? secret : null) },
  } as Request;
}

describe('verifyWebhookSecret', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects empty secret header', async () => {
    const result = await verifyWebhookSecret(req(''), null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/tidak valid/i);
  });

  it('accepts env WEBHOOK_SECRET match', async () => {
    vi.stubEnv('WEBHOOK_SECRET', 'whsec_test_value');
    const result = await verifyWebhookSecret(req('whsec_test_value'), null);
    expect(result).toEqual({ ok: true });
  });

  it('rejects wrong secret when env configured', async () => {
    vi.stubEnv('WEBHOOK_SECRET', 'correct');
    const result = await verifyWebhookSecret(req('wrong'), null);
    expect(result.ok).toBe(false);
  });

  it('resolves paired link from database', async () => {
    vi.stubEnv('WEBHOOK_SECRET', '');
    const link = {
      customerTenantId: 'sppg',
      vendorTenantId: 'vendor1',
      webhookSecret: 'paired-secret',
      status: 'ACTIVE',
    };
    const db = {
      collection: (name: string) => ({
        find: (filter: Record<string, unknown>) => ({
          toArray: async () => (
            name === 'integration_links' && filter.webhookSecret === 'paired-secret' ? [link] : []
          ),
        }),
      }),
    };
    const result = await verifyWebhookSecret(
      req('paired-secret'),
      db as never,
      { customerTenantId: 'sppg', vendorTenantId: 'vendor1' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tenantId).toBe('sppg');
      expect(result.vendorTenantId).toBe('vendor1');
    }
  });
});
