/**
 * Kanal Telegram: tautkan akun via deep link sekali pakai, webhook bot, dan outbox kirim
 * dengan retry. Token bot tidak pernah ditulis ke log/DB/error.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { writeAuditLog } from '@/lib/api/audit-log';
import { getInventoryPublicOrigin } from '@/lib/integration-public-url';
import { logger } from '@/lib/api/logger';

export const TELEGRAM_LINK_TOKENS_COLLECTION = 'telegram_link_tokens';
export const TELEGRAM_UPDATES_COLLECTION = 'telegram_updates';
export const NOTIFICATION_OUTBOX_COLLECTION = 'notification_outbox';

const LINK_TOKEN_TTL_MS = 15 * 60_000;
const SEND_TIMEOUT_MS = 8_000;
const MAX_SEND_ATTEMPTS = 6;
const STALE_PROCESSING_MS = 2 * 60_000;
const OUTBOX_RETENTION_MS = 30 * 86_400_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
const MAX_UPDATE_FAILURES = 3;
const UPDATE_STALE_MS = 60_000;
const LINK_HINT = 'Inventory → ikon lonceng Notifikasi → "Tautkan"';

export type TelegramConfig = {
  token: string;
  botUsername: string;
  webhookSecret: string;
};

export function getTelegramConfig(): TelegramConfig | null {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const botUsername = (process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
  const webhookSecret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  // Tanpa secret webhook, update /start tidak bisa diverifikasi → tautan akun tidak aman.
  if (!token || !botUsername || !webhookSecret) return null;
  return { token, botUsername, webhookSecret };
}

export function isTelegramEnabled(): boolean {
  return getTelegramConfig() !== null;
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join('***') : text;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export async function telegramApi<T = unknown>(
  method: string,
  payload: Record<string, unknown>,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const cfg = getTelegramConfig();
  if (!cfg) throw new TelegramApiError('Telegram belum dikonfigurasi', 0);
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? SEND_TIMEOUT_MS);
  try {
    const res = await doFetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({})) as {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!res.ok || data.ok === false) {
      throw new TelegramApiError(
        redact(String(data.description || `HTTP ${res.status}`), cfg.token),
        res.status,
        data.parameters?.retry_after,
      );
    }
    return data.result as T;
  } catch (e) {
    if (e instanceof TelegramApiError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new TelegramApiError(redact(msg, cfg.token), 0);
  } finally {
    clearTimeout(timer);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TELEGRAM_TEXT_MAX = 4000;

/** Telegram menolak (400 → DEAD) tautan yang bukan URL publik, mis. http://localhost di dev. */
function publicHttpsOrigin(): string {
  const origin = getInventoryPublicOrigin();
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return '';
    if (u.hostname === 'localhost' || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':')) return '';
    return origin;
  } catch {
    return '';
  }
}

/** Teks dipotong SEBELUM di-escape — memotong HTML jadi bisa merusak entitas/tag. */
export function formatTelegramMessage(input: { title: string; body: string; link?: string | null }): string {
  const origin = publicHttpsOrigin();
  const href = input.link && origin ? `${origin}${input.link.startsWith('/') ? '' : '/'}${input.link}` : '';
  const build = (title: string, body: string) => [
    `<b>${escapeHtml(title)}</b>`,
    escapeHtml(body),
    ...(href ? [`<a href="${escapeHtml(href)}">Buka di Inventory</a>`] : []),
  ].join('\n\n');
  const title = input.title.slice(0, 200);
  const full = build(title, input.body);
  if (full.length <= TELEGRAM_TEXT_MAX) return full;
  // Panjang mentah terbesar yang hasil escape-nya masih muat.
  let lo = 0;
  let hi = input.body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(title, `${input.body.slice(0, mid)}…`).length <= TELEGRAM_TEXT_MAX) lo = mid;
    else hi = mid - 1;
  }
  return build(title, `${input.body.slice(0, lo)}…`);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ── Tautkan akun ─────────────────────────────────────────────────────────────

export async function createTelegramLinkToken(
  db: Db,
  user: { userId: string; tenantId: string; name?: string },
): Promise<{ deepLink: string; expiresAt: Date }> {
  const cfg = getTelegramConfig();
  if (!cfg) throw new Error('Telegram belum dikonfigurasi di server');
  const token = randomBytes(24).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LINK_TOKEN_TTL_MS);
  await db.collection(TELEGRAM_LINK_TOKENS_COLLECTION).deleteMany({ userId: user.userId, usedAt: null });
  await db.collection(TELEGRAM_LINK_TOKENS_COLLECTION).insertOne({
    id: uuidv4(),
    tokenHash: hashToken(token),
    userId: user.userId,
    tenantId: user.tenantId,
    usedAt: null,
    createdAt: now,
    expiresAt,
  });
  await writeAuditLog(db, {
    tenantId: user.tenantId,
    action: 'TELEGRAM_LINK_REQUEST',
    entityType: 'user',
    entityId: user.userId,
    summary: 'Minta tautan Telegram',
    userId: user.userId,
    userName: user.name || user.userId,
  });
  return { deepLink: `https://t.me/${cfg.botUsername}?start=${token}`, expiresAt };
}

export async function unlinkTelegram(
  db: Db,
  filter: { userId: string } | { chatId: string },
  actor: { userId: string; userName: string; reason: string },
): Promise<number> {
  const q = 'userId' in filter
    ? { id: filter.userId, telegramChatId: { $type: 'string' } }
    : { telegramChatId: filter.chatId };
  const users = await db.collection('users').find(q).project({ id: 1, tenantId: 1 }).toArray();
  if (!users.length) return 0;
  await db.collection('users').updateMany(
    { id: { $in: users.map((u) => u.id) } },
    { $unset: { telegramChatId: '', telegramUsername: '', telegramLinkedAt: '' } },
  );
  for (const u of users) {
    await writeAuditLog(db, {
      tenantId: String(u.tenantId || ''),
      action: 'TELEGRAM_UNLINK',
      entityType: 'user',
      entityId: String(u.id),
      summary: 'Tautan Telegram diputus',
      metadata: { reason: actor.reason },
      userId: actor.userId,
      userName: actor.userName,
    });
  }
  return users.length;
}

export function verifyTelegramWebhookSecret(headerValue: string | null): boolean {
  const cfg = getTelegramConfig();
  if (!cfg?.webhookSecret) return false;
  const a = Buffer.from(String(headerValue || ''));
  const b = Buffer.from(cfg.webhookSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

type TelegramUpdate = {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: { username?: string };
  };
};

async function reply(chatId: string, text: string): Promise<void> {
  try {
    await telegramApi('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
  } catch (e) {
    logger.warn('telegram reply failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Proses satu update bot (idempoten per `update_id`). Gagal → lempar (webhook non-2xx, Telegram
 * mengulang) sampai MAX_UPDATE_FAILURES; setelah itu dilepas agar update lain tidak tertahan.
 */
export async function handleTelegramUpdate(
  db: Db,
  update: TelegramUpdate,
): Promise<{ action: string }> {
  const updateId = Number(update.update_id);
  const coll = db.collection(TELEGRAM_UPDATES_COLLECTION);
  if (Number.isFinite(updateId)) {
    try {
      await coll.insertOne({
        updateId,
        status: 'PROCESSING',
        failures: 0,
        claimedAt: new Date(),
        createdAt: new Date(),
        expireAt: new Date(Date.now() + 2 * 86_400_000),
      });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      const now = new Date();
      const retry = await coll.findOneAndUpdate(
        {
          updateId,
          failures: { $lt: MAX_UPDATE_FAILURES },
          $or: [
            { status: 'FAILED' },
            // Proses mati di tengah jalan: Telegram tidak dapat balasan lalu mengirim ulang.
            { status: 'PROCESSING', claimedAt: { $lt: new Date(now.getTime() - UPDATE_STALE_MS) } },
          ],
        },
        { $set: { status: 'PROCESSING', claimedAt: now } },
      );
      if (!retry) return { action: 'duplicate' };
    }
  }
  try {
    const result = await processTelegramUpdate(db, update);
    if (Number.isFinite(updateId)) await coll.updateOne({ updateId }, { $set: { status: 'DONE' } });
    return result;
  } catch (e) {
    if (!Number.isFinite(updateId)) throw e;
    const row = await coll.findOneAndUpdate(
      { updateId },
      { $set: { status: 'FAILED' }, $inc: { failures: 1 } },
      { returnDocument: 'after' },
    ).catch(() => null);
    if (row && Number(row.failures) >= MAX_UPDATE_FAILURES) {
      logger.warn('telegram_update_gave_up', { updateId, error: e instanceof Error ? e.message : String(e) });
      return { action: 'error_gave_up' };
    }
    throw e;
  }
}

async function processTelegramUpdate(db: Db, update: TelegramUpdate): Promise<{ action: string }> {
  const msg = update.message;
  const chatId = msg?.chat?.id != null ? String(msg.chat.id) : '';
  const text = String(msg?.text || '').trim();
  if (!chatId || !text) return { action: 'ignored' };
  if (msg?.chat?.type && msg.chat.type !== 'private') return { action: 'ignored_non_private' };

  if (text === '/stop') {
    const n = await unlinkTelegram(db, { chatId }, {
      userId: 'telegram',
      userName: 'Telegram /stop',
      reason: 'user_stop',
    });
    await reply(chatId, n
      ? `Notifikasi dihentikan. Tautkan lagi dari ${LINK_HINT} bila perlu.`
      : 'Chat ini tidak tertaut ke akun Inventory.');
    return { action: n ? 'unlinked' : 'not_linked' };
  }

  const m = text.match(/^\/start(?:\s+([A-Za-z0-9_-]{16,64}))?$/);
  if (!m) {
    await reply(chatId, 'Bot ini hanya mengirim notifikasi Inventory. Ketik /stop untuk berhenti.');
    return { action: 'help' };
  }
  const token = m[1];
  if (!token) {
    await reply(chatId, `Buka ${LINK_HINT} untuk mendapatkan tautan.`);
    return { action: 'start_without_token' };
  }

  const now = new Date();
  const claimed = await db.collection(TELEGRAM_LINK_TOKENS_COLLECTION).findOneAndUpdate(
    { tokenHash: hashToken(token), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    await reply(chatId, `Tautan tidak berlaku atau sudah kedaluwarsa. Buat tautan baru dari ${LINK_HINT}.`);
    return { action: 'invalid_token' };
  }

  let user;
  try {
    user = await db.collection('users').findOne(
      { id: claimed.userId, aktif: { $ne: false } },
      { projection: { id: 1, name: 1, tenantId: 1 } },
    );
    if (user) {
      await db.collection('users').updateOne(
        { id: user.id },
        {
          $set: {
            telegramChatId: chatId,
            telegramUsername: msg?.from?.username ? String(msg.from.username) : null,
            telegramLinkedAt: now,
          },
        },
      );
    }
  } catch (e) {
    // Token dikembalikan agar pengulangan update oleh Telegram bisa menautkan.
    await db.collection(TELEGRAM_LINK_TOKENS_COLLECTION)
      .updateOne({ id: claimed.id, usedAt: now }, { $set: { usedAt: null } })
      .catch(() => undefined);
    throw e;
  }
  if (!user) {
    await reply(chatId, 'Akun tidak ditemukan atau nonaktif.');
    return { action: 'user_missing' };
  }
  await writeAuditLog(db, {
    tenantId: String(user.tenantId || ''),
    action: 'TELEGRAM_LINK',
    entityType: 'user',
    entityId: String(user.id),
    summary: 'Akun Telegram tertaut',
    userId: String(user.id),
    userName: String(user.name || ''),
  });
  await reply(chatId, `Akun ${String(user.name || '')} tertaut. Notifikasi Inventory akan dikirim ke chat ini. Ketik /stop untuk berhenti.`);
  return { action: 'linked' };
}

// ── Outbox kirim ─────────────────────────────────────────────────────────────

export async function enqueueTelegramSend(
  db: Db,
  input: {
    tenantId: string;
    userId: string;
    chatId: string;
    dedupeKey: string;
    title: string;
    body: string;
    link?: string | null;
  },
  opts: { sendNow?: boolean } = {},
): Promise<boolean> {
  if (!isTelegramEnabled()) return false;
  const now = new Date();
  const id = uuidv4();
  try {
    await db.collection(NOTIFICATION_OUTBOX_COLLECTION).insertOne({
      id,
      channel: 'TELEGRAM',
      tenantId: input.tenantId,
      userId: input.userId,
      chatId: input.chatId,
      dedupeKey: input.dedupeKey,
      text: formatTelegramMessage(input),
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      expireAt: new Date(now.getTime() + OUTBOX_RETENTION_MS),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return false;
    throw e;
  }
  if (opts.sendNow !== false) await drainNotificationOutbox(db, { id }).catch(() => undefined);
  return true;
}

/** Kirim antrean Telegram yang jatuh tempo. 403/chat hilang → putus tautan otomatis. */
export async function drainNotificationOutbox(
  db: Db,
  opts: { id?: string; limit?: number; now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<{ sent: number; failed: number; dead: number }> {
  const stats = { sent: 0, failed: 0, dead: 0 };
  if (!isTelegramEnabled()) return stats;
  const limit = opts.limit ?? 50;
  const coll = db.collection(NOTIFICATION_OUTBOX_COLLECTION);

  if (!opts.id) {
    const sweepNow = opts.now ?? new Date();
    const swept = await coll.updateMany(
      {
        status: 'PROCESSING',
        attempts: { $gte: MAX_SEND_ATTEMPTS },
        updatedAt: { $lt: new Date(sweepNow.getTime() - STALE_PROCESSING_MS) },
      },
      { $set: { status: 'DEAD', lastError: 'stale_processing_max_attempts', updatedAt: sweepNow } },
    );
    stats.dead += swept.modifiedCount;
  }

  for (let i = 0; i < limit; i += 1) {
    const now = opts.now ?? new Date();
    const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
    const job = await coll.findOneAndUpdate(
      {
        ...(opts.id ? { id: opts.id } : {}),
        attempts: { $lt: MAX_SEND_ATTEMPTS },
        $or: [
          { status: { $in: ['PENDING', 'FAILED'] }, nextAttemptAt: { $lte: now } },
          { status: 'PROCESSING', updatedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: 'PROCESSING', updatedAt: now }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    );
    if (!job) break;

    try {
      await telegramApi('sendMessage', {
        chat_id: job.chatId,
        text: job.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }, { fetchImpl: opts.fetchImpl });
      await coll.updateOne({ id: job.id }, {
        $set: { status: 'DONE', lastError: null, sentAt: new Date(), updatedAt: new Date() },
      });
      stats.sent += 1;
    } catch (e) {
      const err = e instanceof TelegramApiError ? e : new TelegramApiError(String(e), 0);
      const chatGone = err.status === 403
        || (err.status === 400 && /chat not found|user is deactivated/i.test(err.message));
      // 400 lain (mis. entitas HTML tidak valid) tidak akan berhasil bila diulang.
      const permanent = chatGone || err.status === 400;
      const attempts = Number(job.attempts || 1);
      if (permanent || attempts >= MAX_SEND_ATTEMPTS) {
        await coll.updateOne({ id: job.id }, {
          $set: { status: 'DEAD', lastError: err.message, updatedAt: new Date() },
        });
        if (chatGone) {
          await unlinkTelegram(db, { chatId: String(job.chatId) }, {
            userId: 'system',
            userName: 'Telegram dispatcher',
            reason: `telegram_${err.status}`,
          });
        }
        stats.dead += 1;
      } else {
        const delay = err.retryAfterSec
          ? err.retryAfterSec * 1000
          : RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
        await coll.updateOne({ id: job.id }, {
          $set: {
            status: 'FAILED',
            lastError: err.message,
            nextAttemptAt: new Date(Date.now() + delay),
            updatedAt: new Date(),
          },
        });
        stats.failed += 1;
      }
    }
    if (opts.id) break;
  }
  return stats;
}
