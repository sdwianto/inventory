/** Daftar route API publik — edge-safe (tanpa import MongoDB). */

const PUBLIC = [
  { method: 'GET', route: '/' },
  { method: 'GET', route: '/root' },
  { method: 'GET', route: '/health' },
  { method: 'POST', route: '/auth/login' },
  { method: 'POST', route: '/auth/logout' },
  { method: 'POST', route: '/webhooks/sales' },
  { method: 'POST', route: '/integrations/pair' },
  { method: 'POST', route: '/integrations/platform-pair' },
] as const;

export function isPublicRoute(method: string, route: string): boolean {
  return PUBLIC.some((p) => p.method === method && p.route === route);
}
