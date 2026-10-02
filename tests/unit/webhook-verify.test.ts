import { createHmac, randomUUID } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhookSecret } from '@/lib/api/webhook-verify';

function req(secret: string, extra: Record<string, string> = {}): Request {
  const h: Record<string, string> = { ...(secret ? { 'x-webhook-secret': secret } : {}), ...extra };
  return {
    headers: { get: (k: string) => h[k.toLowerCase()] ?? null },
  } as Request;
}

/** Format persis Sales lib/integration/webhook-signature.ts */
function signed(secret: string, body: string, opts: { ts?: number; nonce?: string } = {}) {
  const timestamp = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? randomUUID();
  const mac = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
  return { 'x-webhook-timestamp': timestamp, 'x-webhook-nonce': nonce, 'x-webhook-signature': `v1=${mac}` };
}

type Link = { customerTenantId: string; vendorTenantId: string; webhookSecret: string; status: string };

function mockDb(links: Link[]) {
  const nonces = new Set<string>();
  return {
    nonces,
    collection: (name: string) => ({
      find: (filter: Record<string, unknown>) => ({
        toArray: async () => (name === 'integration_links'
          ? links.filter((l) => l.webhookSecret === filter.webhookSecret && l.status === filter.status)
          : []),
      }),
      findOne: async (filter: Record<string, unknown>) => (name === 'integration_links'
        ? links.find((l) => l.customerTenantId === filter.customerTenantId
          && l.vendorTenantId === filter.vendorTenantId && l.status === filter.status) ?? null
        : null),
      insertOne: async (doc: { _id: string }) => {
        if (nonces.has(doc._id)) throw Object.assign(new Error('dup'), { code: 11000 });
        nonces.add(doc._id);
        return { acknowledged: true };
      },
    }),
  };
}

const SHARED = 'shared-secret';
const links: Link[] = [
  { customerTenantId: 'sppg', vendorTenantId: 'vendor1', webhookSecret: SHARED, status: 'ACTIVE' },
  { customerTenantId: 'sppg', vendorTenantId: 'vendor2', webhookSecret: SHARED, status: 'ACTIVE' },
  { customerTenantId: 'sppg', vendorTenantId: 'vendor3', webhookSecret: 'own-secret', status: 'ACTIVE' },
];

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
    const result = await verifyWebhookSecret(
      req('own-secret'), mockDb(links) as never, { customerTenantId: 'sppg', vendorTenantId: 'vendor3' },
    );
    expect(result).toEqual({ ok: true, tenantId: 'sppg', vendorTenantId: 'vendor3' });
  });

  it('secret bersama: vendor yang diklaim harus pemilik secret itu', async () => {
    const db = mockDb(links) as never;
    const okRes = await verifyWebhookSecret(req(SHARED), db, { customerTenantId: 'sppg', vendorTenantId: 'vendor2' });
    expect(okRes).toEqual({ ok: true, tenantId: 'sppg', vendorTenantId: 'vendor2' });
    const bad = await verifyWebhookSecret(req(SHARED), db, { customerTenantId: 'sppg', vendorTenantId: 'vendor3' });
    expect(bad).toMatchObject({ ok: false, status: 403 });
  });

  it('secret bersama tanpa klaim vendor ditolak (tidak memilih vendor sembarang)', async () => {
    const res = await verifyWebhookSecret(req(SHARED), mockDb(links) as never, { customerTenantId: 'sppg' });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it('secret milik customer lain ditolak', async () => {
    const res = await verifyWebhookSecret(req('own-secret'), mockDb(links) as never, { customerTenantId: 'lain', vendorTenantId: 'vendor3' });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it('WEBHOOK_SECRET global tidak bisa mengatasnamakan vendor yang sudah dipasangkan', async () => {
    vi.stubEnv('WEBHOOK_SECRET', 'global');
    const db = mockDb(links) as never;
    const res = await verifyWebhookSecret(req('global'), db, { customerTenantId: 'sppg', vendorTenantId: 'vendor1' });
    expect(res).toMatchObject({ ok: false, status: 403 });
    const legacy = await verifyWebhookSecret(req('global'), db, { customerTenantId: 'sppg', vendorTenantId: 'belum-pair' });
    expect(legacy).toEqual({ ok: true });
  });

  describe('tanda tangan HMAC', () => {
    const body = JSON.stringify({ event: 'x', payload: { customerTenantId: 'sppg' } });
    const who = { customerTenantId: 'sppg', vendorTenantId: 'vendor3' };

    it('tanda tangan valid diterima, nonce yang sama ditolak (replay)', async () => {
      const db = mockDb(links) as never;
      const headers = signed('own-secret', body);
      expect(await verifyWebhookSecret(req('own-secret', headers), db, who, { rawBody: body }))
        .toMatchObject({ ok: true, vendorTenantId: 'vendor3' });
      expect(await verifyWebhookSecret(req('own-secret', headers), db, who, { rawBody: body }))
        .toMatchObject({ ok: false, error: expect.stringMatching(/nonce/i) });
    });

    it('body diubah → tanda tangan tidak valid', async () => {
      const res = await verifyWebhookSecret(req('own-secret', signed('own-secret', body)), mockDb(links) as never, who, { rawBody: `${body} ` });
      expect(res).toMatchObject({ ok: false, status: 401 });
    });

    it('timestamp di luar toleransi ditolak', async () => {
      const old = Math.floor(Date.now() / 1000) - 600;
      const res = await verifyWebhookSecret(req('own-secret', signed('own-secret', body, { ts: old })), mockDb(links) as never, who, { rawBody: body });
      expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/kedaluwarsa/i) });
    });

    it('tanpa header secret (legacy dimatikan): secret diambil dari link vendor yang diklaim', async () => {
      const db = mockDb(links) as never;
      expect(await verifyWebhookSecret(req('', signed('own-secret', body)), db, who, { rawBody: body }))
        .toMatchObject({ ok: true, vendorTenantId: 'vendor3' });
      expect(await verifyWebhookSecret(req('', signed('tebakan', body)), db, who, { rawBody: body }))
        .toMatchObject({ ok: false });
    });

    it('WEBHOOK_REQUIRE_SIGNATURE=1 menolak request tanpa tanda tangan', async () => {
      vi.stubEnv('WEBHOOK_REQUIRE_SIGNATURE', '1');
      const res = await verifyWebhookSecret(req('own-secret'), mockDb(links) as never, who, { rawBody: body });
      expect(res).toMatchObject({ ok: false, status: 401 });
    });
  });
});
