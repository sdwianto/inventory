/** Notifikasi in-app milik user login + pengaturan tautan Telegram. */

import type { NextResponse } from 'next/server';
import { ok, err } from '@/lib/api/db';
import type { HandlerContext } from '@/types/api/handler';
import { NOTIFICATIONS_COLLECTION } from '@/lib/notifications/notify';

const MAX_LIST = 50;

export async function handleNotifications({
  db,
  route,
  method,
  path,
  url,
  auth,
}: HandlerContext): Promise<NextResponse | null> {
  if (path[0] !== 'notifications') return null;
  if (!auth?.userId || auth.isApiKey) return err('Tidak terautentikasi', 401);
  const userId = auth.userId;

  if (route === '/notifications' && method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), MAX_LIST);
    const unreadOnly = url.searchParams.get('unread') === '1';
    const [items, unread] = await Promise.all([
      db.collection(NOTIFICATIONS_COLLECTION)
        .find({ userId, ...(unreadOnly ? { readAt: null } : {}) })
        .project({ _id: 0, expireAt: 0, dedupeKey: 0 })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray(),
      db.collection(NOTIFICATIONS_COLLECTION).countDocuments({ userId, readAt: null }),
    ]);
    return ok({ items, unread });
  }

  if (route === '/notifications/unread-count' && method === 'GET') {
    const unread = await db.collection(NOTIFICATIONS_COLLECTION).countDocuments({ userId, readAt: null });
    return ok({ unread });
  }

  if (route === '/notifications/read-all' && method === 'POST') {
    const res = await db.collection(NOTIFICATIONS_COLLECTION).updateMany(
      { userId, readAt: null },
      { $set: { readAt: new Date() } },
    );
    return ok({ updated: res.modifiedCount });
  }

  if (path.length === 3 && path[2] === 'read' && method === 'POST' && path[1] !== 'telegram') {
    const res = await db.collection(NOTIFICATIONS_COLLECTION).updateOne(
      { id: path[1], userId, readAt: null },
      { $set: { readAt: new Date() } },
    );
    return ok({ updated: res.modifiedCount });
  }

  if (route === '/notifications/telegram' && method === 'GET') {
    const { getTelegramConfig } = await import('@/lib/notifications/telegram');
    const cfg = getTelegramConfig();
    const user = await db.collection('users').findOne(
      { id: userId },
      { projection: { telegramChatId: 1, telegramUsername: 1, telegramLinkedAt: 1 } },
    );
    return ok({
      enabled: Boolean(cfg),
      botUsername: cfg?.botUsername ?? null,
      linked: Boolean(user?.telegramChatId),
      telegramUsername: user?.telegramUsername ?? null,
      linkedAt: user?.telegramLinkedAt ?? null,
    });
  }

  if (route === '/notifications/telegram/link' && method === 'POST') {
    const { createTelegramLinkToken, isTelegramEnabled } = await import('@/lib/notifications/telegram');
    if (!isTelegramEnabled()) return err('Telegram belum dikonfigurasi di server', 503);
    const link = await createTelegramLinkToken(db, {
      userId,
      tenantId: auth.tenantId,
      name: auth.name,
    });
    return ok(link);
  }

  if (route === '/notifications/telegram/unlink' && method === 'POST') {
    const { unlinkTelegram } = await import('@/lib/notifications/telegram');
    const n = await unlinkTelegram(db, { userId }, {
      userId,
      userName: auth.name || auth.email,
      reason: 'user_profile',
    });
    return ok({ unlinked: n > 0 });
  }

  return null;
}

/** POST /telegram/webhook — publik, diverifikasi header secret Telegram. */
export async function handleTelegramWebhook({
  db,
  route,
  method,
  request,
  body,
}: HandlerContext): Promise<NextResponse | null> {
  if (route !== '/telegram/webhook' || method !== 'POST') return null;
  const { verifyTelegramWebhookSecret, handleTelegramUpdate } = await import('@/lib/notifications/telegram');
  if (!verifyTelegramWebhookSecret(request.headers.get('x-telegram-bot-api-secret-token'))) {
    return err('Unauthorized', 401);
  }
  try {
    const result = await handleTelegramUpdate(db, (body || {}) as Parameters<typeof handleTelegramUpdate>[1]);
    return ok(result);
  } catch {
    // Tetap 200 agar Telegram tidak mengulang update tanpa henti; update_id sudah tercatat.
    return ok({ action: 'error' });
  }
}
