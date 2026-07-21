import { afterEach, describe, expect, it } from 'vitest';
import { shouldProcessWebhookInline } from '@/lib/api/webhook-inbox-process';

describe('shouldProcessWebhookInline', () => {
  const originalMode = process.env.DEPLOYMENT_MODE;

  afterEach(() => {
    if (originalMode == null) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
  });

  it('inlines delivery.shipped only on serverless (VPS uses async push)', () => {
    process.env.DEPLOYMENT_MODE = 'vps';
    expect(shouldProcessWebhookInline('delivery.shipped')).toBe(false);
    process.env.DEPLOYMENT_MODE = 'serverless';
    expect(shouldProcessWebhookInline('delivery.shipped')).toBe(true);
  });

  it('never inlines sales_order events (always WEBHOOK_INBOX job)', () => {
    process.env.DEPLOYMENT_MODE = 'vps';
    expect(shouldProcessWebhookInline('sales_order.confirmed')).toBe(false);
    expect(shouldProcessWebhookInline('sales_order.updated')).toBe(false);
    process.env.DEPLOYMENT_MODE = 'serverless';
    expect(shouldProcessWebhookInline('sales_order.confirmed')).toBe(false);
  });
});
