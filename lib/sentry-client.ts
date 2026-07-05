/** Client-side Sentry envelope — pakai NEXT_PUBLIC_SENTRY_DSN (P1.1a). */

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

export async function captureClientError(
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  if (!dsn) return;
  const parsed = parseDsn(dsn);
  if (!parsed) return;

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
      platform: 'javascript',
      level: 'error',
      message,
      extra: extra || {},
      tags: { app: 'inventory', service: 'inventory-app-client' },
    }),
  ].join('\n');

  const ingest = `https://${parsed.host}/api/${parsed.projectId}/envelope/`;
  try {
    await fetch(ingest, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=inventory-lite-client/1.0, sentry_key=${parsed.publicKey}`,
      },
      body: envelope,
      keepalive: true,
    });
  } catch {
    // best-effort
  }
}
