import { describe, expect, it } from 'vitest';
import { isPublicRoute } from '@/lib/api/public-routes';

describe('isPublicRoute — Category A/B integration webhooks dari Sales', () => {
  const webhookRoutes = [
    'delivery-shipped',
    'invoice-posted',
    'credit-note-posted',
    'debit-note-posted',
    'vendor-return-decision',
    'product-upserted',
  ];

  it.each(webhookRoutes)('POST /integrations/%s bebas dari auth session (auth via X-Webhook-Secret di handler)', (name) => {
    expect(isPublicRoute('POST', `/integrations/${name}`)).toBe(true);
  });

  it.each(webhookRoutes)('POST /v1/integrations/%s (bentuk nyata yang dipanggil client) juga bebas dari auth session', (name) => {
    expect(isPublicRoute('POST', `/v1/integrations/${name}`)).toBe(true);
  });

  it('GET pada route webhook manapun TETAP butuh auth (bukan public secara method)', () => {
    expect(isPublicRoute('GET', '/integrations/vendor-return-decision')).toBe(false);
  });

  it('route acak yang tidak terdaftar tetap butuh auth (default deny)', () => {
    expect(isPublicRoute('POST', '/integrations/tidak-ada')).toBe(false);
  });
});
