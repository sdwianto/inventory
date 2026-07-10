/** Picu worker bg_jobs di instance terpisah — jangan proses job berat di lambda request user. */

export async function kickBgWorker(opts?: { limit?: number; baseUrl?: string }): Promise<boolean> {
  const secret = String(process.env.WORKER_SECRET || process.env.CRON_SECRET || '').trim();
  if (!secret) return false;

  const raw = String(
    opts?.baseUrl
    || process.env.INVENTORY_APP_URL
    || process.env.VERCEL_URL
    || process.env.NEXT_PUBLIC_VERCEL_URL
    || '',
  ).trim();
  if (!raw) return false;

  const base = raw.startsWith('http') ? raw.replace(/\/$/, '') : `https://${raw.replace(/\/$/, '')}`;
  const limit = Math.min(5, Math.max(1, opts?.limit ?? 2));

  try {
    await fetch(`${base}/api/bg-jobs/process?limit=${limit}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secret}`,
        'X-Worker-Secret': secret,
      },
      signal: AbortSignal.timeout(8_000),
    });
    return true;
  } catch {
    return false;
  }
}
