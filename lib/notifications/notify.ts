/**
 * Notifikasi in-app per user (+ salinan Telegram bila akun tertaut).
 * Idempoten via unique `(tenantId, userId, dedupeKey)` — kirim ulang tidak menggandakan.
 */

import { MongoBulkWriteError, type AnyBulkWriteOperation, type Db, type Document } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';

export const NOTIFICATIONS_COLLECTION = 'notifications';
export const NOTIFICATION_RETENTION_DAYS = 90;

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export type NotificationRecipient = {
  id: string;
  name: string;
  role: string;
  telegramChatId: string | null;
};

export type NotifyInput = {
  tenantId: string;
  recipients: NotificationRecipient[];
  type: string;
  title: string;
  body: string;
  link?: string | null;
  severity?: NotificationSeverity;
  dedupeKey: string;
  refType?: string | null;
  refId?: string | null;
  /** Default true — kirim salinan ke Telegram penerima yang tertaut. */
  telegram?: boolean;
  /** Default true — kirim Telegram langsung; false = hanya antre (job batch, dikirim cron drain). */
  telegramSendNow?: boolean;
};

/**
 * User aktif satu tenant: pemilik `userIds` + semua user dengan salah satu `roles`.
 * MASTER tidak diikutkan lewat role (lintas tenant) kecuali disebut eksplisit di `userIds`.
 */
export async function resolveRecipients(
  db: Db,
  tenantId: string,
  opts: { roles?: string[]; userIds?: string[] },
): Promise<NotificationRecipient[]> {
  const roles = (opts.roles || []).filter((r) => r && r !== 'MASTER');
  const userIds = [...new Set((opts.userIds || []).filter(Boolean))];
  const or: Document[] = [];
  if (roles.length) or.push({ tenantId, role: { $in: roles } });
  if (userIds.length) or.push({ id: { $in: userIds } });
  if (!or.length) return [];

  const rows = await db.collection('users')
    .find({ $or: or, aktif: { $ne: false } })
    .project({ id: 1, name: 1, role: 1, tenantId: 1, telegramChatId: 1 })
    .toArray();

  const seen = new Set<string>();
  const out: NotificationRecipient[] = [];
  for (const u of rows) {
    const id = String(u.id || '');
    if (!id || seen.has(id)) continue;
    if (u.role !== 'MASTER' && String(u.tenantId || '') !== tenantId) continue;
    seen.add(id);
    out.push({
      id,
      name: String(u.name || ''),
      role: String(u.role || ''),
      telegramChatId: u.telegramChatId ? String(u.telegramChatId) : null,
    });
  }
  return out;
}

export async function notifyUsers(
  db: Db,
  input: NotifyInput,
): Promise<{ inserted: number; insertedUserIds: string[]; telegramQueued: number }> {
  if (!input.recipients.length) return { inserted: 0, insertedUserIds: [], telegramQueued: 0 };
  const now = new Date();
  const expireAt = new Date(now.getTime() + NOTIFICATION_RETENTION_DAYS * 86_400_000);

  const ops: AnyBulkWriteOperation[] = input.recipients.map((r) => ({
    updateOne: {
      filter: { tenantId: input.tenantId, userId: r.id, dedupeKey: input.dedupeKey },
      update: {
        $setOnInsert: {
          id: uuidv4(),
          tenantId: input.tenantId,
          userId: r.id,
          type: input.type,
          title: input.title,
          body: input.body,
          link: input.link ?? null,
          severity: input.severity ?? 'info',
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          dedupeKey: input.dedupeKey,
          readAt: null,
          createdAt: now,
          expireAt,
        },
      },
      upsert: true,
    },
  }));

  let upsertedIds: Record<number, unknown>;
  try {
    const res = await db.collection(NOTIFICATIONS_COLLECTION).bulkWrite(ops, { ordered: false });
    upsertedIds = res.upsertedIds || {};
  } catch (e) {
    // Upsert paralel dengan dedupeKey sama → E11000; baris itu sudah dibuat proses lain.
    if (!(e instanceof MongoBulkWriteError)) throw e;
    const writeErrors = Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors];
    if (writeErrors.some((w) => w.code !== 11000)) throw e;
    upsertedIds = e.result?.upsertedIds || {};
  }
  const upsertedIdx = Object.keys(upsertedIds).map(Number);
  const insertedRecipients = upsertedIdx.map((i) => input.recipients[i]).filter(Boolean);

  // Semua penerima tertaut (bukan hanya yang baru disisipkan): bila proses sebelumnya mati setelah
  // menulis notifikasi tapi sebelum mengantre Telegram, pengulangan melengkapinya. Outbox unik per
  // (userId, dedupeKey) → tidak terkirim ganda.
  let telegramQueued = 0;
  if (input.telegram !== false) {
    const { enqueueTelegramSend } = await import('@/lib/notifications/telegram');
    for (const r of input.recipients) {
      if (!r.telegramChatId) continue;
      const queued = await enqueueTelegramSend(db, {
        tenantId: input.tenantId,
        userId: r.id,
        chatId: r.telegramChatId,
        dedupeKey: input.dedupeKey,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
      }, { sendNow: input.telegramSendNow });
      if (queued) telegramQueued += 1;
    }
  }

  return {
    inserted: insertedRecipients.length,
    insertedUserIds: insertedRecipients.map((r) => r.id),
    telegramQueued,
  };
}
