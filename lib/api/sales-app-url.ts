/** Resolve sales.app URL — hindari localhost/Vercel stale di DB saat env VPS sudah benar. */

export function isLoopbackSalesUrl(url: string | null | undefined): boolean {
  const raw = String(url || '').trim().toLowerCase();
  if (!raw) return true;
  try {
    const parsed = new URL(raw.startsWith('http') ? raw : `http://${raw}`);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return /localhost|127\.0\.0\.1/.test(raw);
  }
}

/** URL cloud lama yang tidak boleh dipakai di stack VPS Docker. */
export function isStaleCloudSalesUrl(url: string | null | undefined): boolean {
  const raw = String(url || '').trim().toLowerCase();
  if (!raw) return false;
  return /vercel\.app|penarukan2\.vercel/.test(raw);
}

function isVpsDeployment(): boolean {
  return String(process.env.DEPLOYMENT_MODE || '').toLowerCase() === 'vps';
}

export function resolveEffectiveSalesAppUrl(storedUrl?: string | null): string {
  const fromEnv = String(process.env.SALES_APP_URL || '').trim().replace(/\/$/, '');
  const stored = String(storedUrl || '').trim().replace(/\/$/, '');

  if (fromEnv && isLoopbackSalesUrl(stored)) return fromEnv;
  // VPS: env docker (http://sales:3000) menang atas URL Vercel stale di Mongo.
  if (fromEnv && isVpsDeployment() && isStaleCloudSalesUrl(stored)) return fromEnv;
  if (stored) return stored;
  return fromEnv || 'http://localhost:3000';
}
