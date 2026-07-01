/** URL publik inventory untuk panduan integrasi & webhook sales.app */

export function getInventoryPublicOrigin(): string {
  const fromEnv = (process.env.NEXT_PUBLIC_BASE_URL || process.env.VERCEL_URL || '').trim();
  if (!fromEnv) return '';
  if (fromEnv.startsWith('http')) return fromEnv.replace(/\/$/, '');
  return `https://${fromEnv.replace(/\/$/, '')}`;
}

export function getInventoryWebhookUrl(origin?: string): string {
  const base = (origin || getInventoryPublicOrigin() || 'http://localhost:3001').replace(/\/$/, '');
  return `${base}/api/webhooks/sales`;
}

export function getInventoryPairUrl(origin?: string): string {
  const base = (origin || getInventoryPublicOrigin() || 'http://localhost:3001').replace(/\/$/, '');
  return `${base}/api/integrations/pair`;
}
