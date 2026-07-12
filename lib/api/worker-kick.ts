/** Picu worker bg_jobs — serverless / legacy poll only (EE-10). */

import { shouldUseLegacyBgPoll } from '@/lib/api/execution-wave';

const PROD_INVENTORY_DEFAULT = 'https://penarukan2.vercel.app';

export async function kickBgWorker(opts?: { limit?: number; baseUrl?: string }): Promise<boolean> {
  if (!shouldUseLegacyBgPoll()) return false;

  const secret = String(process.env.WORKER_SECRET || process.env.CRON_SECRET || '').trim();
  if (!secret) return false;

  const raw = String(
    opts?.baseUrl
    || process.env.INVENTORY_APP_URL
    || process.env.VERCEL_URL
    || process.env.NEXT_PUBLIC_VERCEL_URL
    || '',
  ).trim();
  const base = (() => {
    if (!raw) return PROD_INVENTORY_DEFAULT;
    if (/localhost|127\.0\.0\.1/i.test(raw)) return PROD_INVENTORY_DEFAULT;
    return raw.startsWith('http') ? raw.replace(/\/$/, '') : `https://${raw.replace(/\/$/, '')}`;
  })();
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
