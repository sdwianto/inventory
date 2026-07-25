/** Daftar route API publik — edge-safe (tanpa import MongoDB). */

const PUBLIC = [
  { method: 'GET', route: '/' },
  { method: 'GET', route: '/root' },
  { method: 'GET', route: '/health' },
  { method: 'POST', route: '/auth/login' },
  { method: 'POST', route: '/auth/logout' },
  { method: 'POST', route: '/webhooks/sales' },
  { method: 'GET', route: '/integrations/public-info' },
  { method: 'GET', route: '/v1/integrations/public-info' },
  { method: 'POST', route: '/integrations/pair' },
  { method: 'POST', route: '/integrations/platform-pair' },
  // Category A inbound dari Sales — auth via X-Webhook-Secret di handler.
  { method: 'POST', route: '/integrations/delivery-shipped' },
  { method: 'POST', route: '/integrations/invoice-posted' },
  { method: 'POST', route: '/v1/integrations/delivery-shipped' },
  { method: 'POST', route: '/v1/integrations/invoice-posted' },
] as const;

export function isPublicRoute(method: string, route: string): boolean {
  return PUBLIC.some((p) => p.method === method && p.route === route);
}
