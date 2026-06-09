// Outbound webhook ke sistem customer / integrasi eksternal.

export async function emitWebhook(db, tenantId, event, payload) {
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
      console.warn(`Webhook ${event} → ${sub.url}:`, e.message);
    }
  }));
}
