import type { Db } from 'mongodb';
// Outbound webhook ke sistem customer / integrasi eksternal.

export async function emitWebhook(
  db: Db,
  tenantId: string | null | undefined,
  event: string,
  payload: unknown,
): Promise<void> {
  const tid = tenantId || 'default';
  const subs = await db.collection('webhook_subscriptions')
    .find({ tenantId: tid, event, aktif: { $ne: false } })
    .toArray();
  if (!subs.length) return;

  const body = JSON.stringify({
    event,
    tenantId: tid,
    payload,
    emittedAt: new Date().toISOString(),
  });

  await Promise.all(subs.map(async (sub) => {
    try {
      await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': sub.secret || '',
          'X-Event': event,
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`Webhook ${event} → ${sub.url}:`, msg);
    }
  }));
}
