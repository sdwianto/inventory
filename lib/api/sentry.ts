/** Optional Sentry capture — aktif jika SENTRY_DSN diset (P1.1a). */

import { logger } from '@/lib/api/logger';

interface ParsedDsn {
  host: string;
  projectId: string;
  publicKey: string;
}

function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, '');
    const publicKey = u.username;
    if (!publicKey || !projectId) return null;
    return { host: u.host, projectId, publicKey };
  } catch {
    return null;
  }
}

function serverDsn(): string | null {
  const dsn = process.env.SENTRY_DSN?.trim() || process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  return dsn || null;
}

export function isSentryEnabled(): boolean {
  return !!serverDsn();
}

export async function captureException(
  error: unknown,
  context?: Record<string, unknown>,
): Promise<void> {
  const dsn = serverDsn();
  if (!dsn) return;

  const parsed = parseDsn(dsn);
  if (!parsed) return;

  const err = error instanceof Error ? error : new Error(String(error));
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const envelope = [
    JSON.stringify({
      event_id: eventId,
      sent_at: new Date().toISOString(),
      dsn,
    }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify({
      event_id: eventId,
      timestamp: new Date().toISOString(),
      platform: 'node',
      level: 'error',
      exception: {
        values: [{
          type: err.name,
          value: err.message,
          stacktrace: err.stack ? { frames: [] } : undefined,
        }],
      },
      extra: context || {},
      tags: {
        app: 'inventory',
        service: 'inventory-app',
      },
    }),
  ].join('\n');

  const ingest = `https://${parsed.host}/api/${parsed.projectId}/envelope/`;
  try {
    await fetch(ingest, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=inventory-lite/1.0, sentry_key=${parsed.publicKey}`,
      },
      body: envelope,
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    logger.warn('sentry_capture_failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
