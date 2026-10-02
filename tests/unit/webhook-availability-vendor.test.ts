import { describe, expect, it, vi } from 'vitest';
import type { HandlerContext } from '@/types/api/handler';

vi.mock('@/lib/api/webhook-verify', () => ({
  verifyWebhookSecret: async () => ({ ok: true, tenantId: 'cust', vendorTenantId: 'v-asli' }),
}));

const { handleWebhooks } = await import('@/lib/api/handlers/webhooks');

function call(event: string, envelopeTenant: string | undefined) {
  const db = {
    collection: () => ({ findOne: async () => ({ status: 'PROCESSED', result: {} }) }),
  };
  const body = {
    event,
    ...(envelopeTenant ? { tenantId: envelopeTenant } : {}),
    payload: { customerTenantId: 'cust', salesOrderId: 'so-1', customerPoId: 'po-1', computedAt: '2026-10-01T00:00:00.000Z' },
  };
  const url = new URL('http://local/api/webhooks/sales');
  return handleWebhooks({
    db, route: '/webhooks/sales', method: 'POST', path: ['webhooks', 'sales'], body, url, auth: null,
    request: new Request(url, { method: 'POST' }),
  } as unknown as HandlerContext);
}

describe('webhook availability_changed: vendor dari secret terverifikasi', () => {
  it('tenantId vendor di envelope beda dari pemilik secret → 403', async () => {
    const res = await call('sales_order.availability_changed', 'v-palsu');
    expect(res!.status).toBe(403);
  });

  it('event lain dengan vendor envelope beda juga ditolak 403 (bukan sekadar warning)', async () => {
    const res = await call('sales_order.confirmed', 'v-palsu');
    expect(res!.status).toBe(403);
  });

  it('tanpa envelope → vendor dari secret dipakai', async () => {
    const res = await call('sales_order.availability_changed', undefined);
    const json = await res!.json() as Record<string, unknown>;
    expect(json.dedupeKey).toBe('sales_order.availability_changed:so-1:2026-10-01T00:00:00.000Z:cust:v-asli');
  });
});
