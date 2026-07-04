/** Resolve sales.app URL — hindari localhost stale di DB saat env production sudah benar. */

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

export function resolveEffectiveSalesAppUrl(storedUrl?: string | null): string {
  const fromEnv = String(process.env.SALES_APP_URL || '').trim().replace(/\/$/, '');
  const stored = String(storedUrl || '').trim().replace(/\/$/, '');

  if (fromEnv && isLoopbackSalesUrl(stored)) return fromEnv;
  if (stored) return stored;
  return fromEnv || 'http://localhost:3000';
}
