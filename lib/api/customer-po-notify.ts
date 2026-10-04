/**
 * Notifikasi alur persetujuan PO ke Vendor (lonceng + Telegram):
 * diajukan → semua ADMIN tenant; disetujui/ditolak → pengaju & pembuat PO.
 * Best-effort: kegagalan hanya di-log, tidak pernah menggagalkan aksi PO.
 */

import type { Db } from 'mongodb';
import { resolveRecipients, notifyUsers, type NotificationRecipient } from '@/lib/notifications/notify';
import { logger } from '@/lib/api/logger';
import type { JsonObject } from '@/types/json';

export const PO_APPROVAL_NOTIFY_ROLES = ['ADMIN'];
const TEXT_MAX = 300;
const VENDOR_NAMES_MAX = 5;

type Actor = { userId?: string; userName?: string } | null | undefined;

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function clip(s: string, max = TEXT_MAX): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function isoKey(v: unknown): string {
  const d = v instanceof Date ? v : new Date(str(v));
  return Number.isNaN(d.getTime()) ? str(v) : d.toISOString();
}

export function formatPoDate(v: unknown): string {
  if (!v) return '-';
  const d = v instanceof Date ? v : new Date(str(v));
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jakarta',
  }).format(d);
}

function formatIdr(n: unknown): string | null {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return `Rp ${Math.round(v).toLocaleString('id-ID')}`;
}

function poLabel(po: JsonObject): string {
  return str(po.noPO) || str(po.id);
}

function poLink(po: JsonObject): string {
  return `/pembelian-po?highlight=${encodeURIComponent(str(po.id))}`;
}

function activeItems(po: JsonObject): JsonObject[] {
  const items = Array.isArray(po.items) ? (po.items as JsonObject[]) : [];
  return items.filter((it) => it && it.cancelled !== true);
}

export function poVendorIds(po: JsonObject): string[] {
  const ids = new Set<string>();
  for (const it of activeItems(po)) {
    const v = str(it.vendorTenantId);
    if (v && v !== 'multi') ids.add(v);
  }
  const top = str(po.vendorTenantId);
  if (!ids.size && top && top !== 'multi') ids.add(top);
  return [...ids];
}

async function vendorNames(db: Db, tenantId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.collection('vendor_tenants')
    .find({ tenantId, vendorTenantId: { $in: ids } })
    .project({ vendorTenantId: 1, vendorTenantName: 1 })
    .toArray();
  const byId = new Map(rows.map((r) => [str(r.vendorTenantId), str(r.vendorTenantName)]));
  return ids.map((id) => byId.get(id) || id);
}

function vendorLine(names: string[]): string | null {
  if (!names.length) return null;
  const shown = names.slice(0, VENDOR_NAMES_MAX).join(', ');
  const more = names.length > VENDOR_NAMES_MAX ? ` +${names.length - VENDOR_NAMES_MAX} lainnya` : '';
  return `Vendor: ${clip(shown + more)}`;
}

export function buildApprovalRequestedMessage(
  po: JsonObject,
  submitter: Actor,
  vendors: string[],
): { title: string; body: string } {
  const total = formatIdr(po.estimasiTotal);
  const catatan = clip(str(po.catatan), 200);
  const lines = [
    `Diajukan oleh: ${clip(str(submitter?.userName) || 'Pengguna', 120)}`,
    `Kedatangan: ${formatPoDate(po.tanggalKedatangan)}`,
    vendorLine(vendors),
    `Jumlah item: ${activeItems(po).length}`,
    total ? `Estimasi total: ${total}` : null,
    catatan ? `Catatan: ${catatan}` : null,
    'Mohon segera ditinjau dan disetujui.',
  ].filter(Boolean);
  return { title: `PO menunggu persetujuan: ${poLabel(po)}`, body: lines.join('\n') };
}

export function buildApprovedMessage(
  po: JsonObject,
  approver: Actor,
  sync: { vendorSynced?: boolean; vendorSyncPending?: boolean; vendorSyncError?: unknown } = {},
): { title: string; body: string } {
  let syncLine = 'PO sudah dikirim ke vendor.';
  if (sync.vendorSyncError) syncLine = 'Pengiriman ke vendor belum berhasil — sistem akan mencoba ulang otomatis.';
  else if (sync.vendorSyncPending || sync.vendorSynced === false) syncLine = 'Pengiriman ke vendor sedang diproses.';
  return {
    title: `PO disetujui: ${poLabel(po)}`,
    body: [
      `Disetujui oleh: ${clip(str(approver?.userName) || 'Admin', 120)}`,
      `Kedatangan: ${formatPoDate(po.tanggalKedatangan)}`,
      syncLine,
    ].join('\n'),
  };
}

export function buildRejectedMessage(po: JsonObject, rejector: Actor, reason: string): { title: string; body: string } {
  return {
    title: `PO ditolak: ${poLabel(po)}`,
    body: [
      `Ditolak oleh: ${clip(str(rejector?.userName) || 'Admin', 120)}`,
      `Alasan: ${clip(reason || 'Ditolak admin')}`,
      'Perbaiki PO lalu ajukan ulang.',
    ].join('\n'),
  };
}

/** Pelaku tidak perlu menerima notifikasi atas aksinya sendiri. */
export function excludeActor(recipients: NotificationRecipient[], actor: Actor): NotificationRecipient[] {
  const actorId = str(actor?.userId);
  return actorId ? recipients.filter((r) => r.id !== actorId) : recipients;
}

async function deliver(
  db: Db,
  po: JsonObject,
  recipients: NotificationRecipient[],
  input: { type: string; title: string; body: string; severity: 'info' | 'warning'; dedupeKey: string },
) {
  const tenantId = str(po.tenantId);
  if (!recipients.length) return { inserted: 0, telegramQueued: 0 };
  const res = await notifyUsers(db, {
    tenantId,
    recipients,
    type: input.type,
    title: input.title,
    body: input.body,
    link: poLink(po),
    severity: input.severity,
    dedupeKey: input.dedupeKey,
    refType: 'customer_purchase_order',
    refId: str(po.id),
    // Jangan tahan respons API menunggu Telegram (timeout 8 dtk/pesan); outbox dikuras di latar & oleh cron.
    telegramSendNow: false,
  });
  if (res.telegramQueued > 0) {
    void import('@/lib/notifications/telegram')
      .then(({ drainNotificationOutbox }) => drainNotificationOutbox(db, { limit: 20 }))
      .catch((e) => logger.warn('po_approval_telegram_drain_failed', { error: e instanceof Error ? e.message : String(e) }));
  }
  return res;
}

async function safely<T>(event: string, po: JsonObject, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    logger.warn(event, { poId: str(po?.id), tenantId: str(po?.tenantId), error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export function notifyPoApprovalRequested(db: Db, po: JsonObject | null | undefined, submitter: Actor) {
  if (!po) return Promise.resolve(null);
  return safely('po_approval_request_notify_failed', po, async () => {
    const tenantId = str(po.tenantId);
    const [admins, vendors] = await Promise.all([
      resolveRecipients(db, tenantId, { roles: PO_APPROVAL_NOTIFY_ROLES }),
      vendorNames(db, tenantId, poVendorIds(po)),
    ]);
    const msg = buildApprovalRequestedMessage(po, submitter, vendors);
    return deliver(db, po, excludeActor(admins, submitter), {
      type: 'PO_APPROVAL_REQUESTED',
      ...msg,
      severity: 'warning',
      dedupeKey: `po-approval-req:${str(po.id)}:${isoKey(po.requestedAt)}`,
    });
  });
}

async function requesterRecipients(db: Db, po: JsonObject, actor: Actor) {
  const createdBy = (po.createdBy || {}) as JsonObject;
  const requestedBy = (po.requestedBy || {}) as JsonObject;
  const list = await resolveRecipients(db, str(po.tenantId), {
    userIds: [str(requestedBy.userId), str(createdBy.userId)],
  });
  return excludeActor(list, actor);
}

export function notifyPoApproved(
  db: Db,
  po: JsonObject | null | undefined,
  approver: Actor,
  sync: { vendorSynced?: boolean; vendorSyncPending?: boolean; vendorSyncError?: unknown } = {},
) {
  if (!po) return Promise.resolve(null);
  return safely('po_approved_notify_failed', po, async () => {
    const msg = buildApprovedMessage(po, approver, sync);
    return deliver(db, po, await requesterRecipients(db, po, approver), {
      type: 'PO_APPROVED',
      ...msg,
      severity: 'info',
      dedupeKey: `po-approved:${str(po.id)}:${isoKey(po.approvedAt)}`,
    });
  });
}

export function notifyPoRejected(db: Db, po: JsonObject | null | undefined, rejector: Actor, reason: string) {
  if (!po) return Promise.resolve(null);
  return safely('po_rejected_notify_failed', po, async () => {
    const msg = buildRejectedMessage(po, rejector, reason);
    return deliver(db, po, await requesterRecipients(db, po, rejector), {
      type: 'PO_REJECTED',
      ...msg,
      severity: 'warning',
      dedupeKey: `po-rejected:${str(po.id)}:${isoKey(po.rejectedAt)}`,
    });
  });
}
