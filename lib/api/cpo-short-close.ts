/**
 * Tutup sisa backorder PO (short-close): sisa qty baris yang belum diterima ditutup
 * sehingga GRN berikutnya dihitung lebih-terima dan status PO bisa maju ke RECEIVED.
 */

import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import { writeAuditLog } from '@/lib/api/audit-log';
import { pickForwardCpoStatus, rollupCpoProgressStatus, lineBackorderQty, type CpoLine } from '@/lib/api/cpo-status-sync';
import { poLineRemaining } from '@/lib/api/po-receive-control';
import { roundQty } from '@/lib/stock-ledger/precision';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';

export const PO_SHORT_CLOSE_ROLES = new Set(['SUPERVISOR', 'ADMIN', 'MASTER', 'OWNER']);

const SHORT_CLOSABLE_STATUSES = new Set(['CONFIRMED', 'PARTIAL_CANCELLED', 'PARTIAL_SHIPPED', 'SHIPPED', 'PARTIAL_RECEIVED']);

export type PoShortCloseActor = { userId: string; userName: string; role?: string };

export type PoShortCloseResult =
  | { ok: true; poId: string; noPO: string; status: string; lines: Array<{ lineId?: string; nama?: string; satuan?: string; qtyClosed: number }> }
  | { ok: false; status: number; error: string };

export async function shortClosePoRemaining(
  db: Db,
  session: ClientSession | undefined,
  input: { tenantId: string; poId: string; reason: string; actor: PoShortCloseActor },
): Promise<PoShortCloseResult> {
  const reason = String(input.reason || '').trim();
  if (reason.length < 3) return { ok: false, status: 400, error: 'Alasan tutup sisa PO wajib (minimal 3 karakter)' };
  if (!PO_SHORT_CLOSE_ROLES.has(String(input.actor.role || '').toUpperCase())) {
    return { ok: false, status: 403, error: 'Tutup sisa PO hanya untuk SUPERVISOR/ADMIN/OWNER' };
  }

  const po = await db.collection('customer_purchase_orders').findOne(
    { ...tenantIdMatchFilter(input.tenantId), id: input.poId },
    txOpts(session),
  ) as (Record<string, unknown> & { items?: CpoLine[] }) | null;
  if (!po) return { ok: false, status: 404, error: 'PO tidak ditemukan' };
  const status = String(po.status || '');
  if (!SHORT_CLOSABLE_STATUSES.has(status)) {
    return { ok: false, status: 400, error: `PO status ${status || '-'} tidak punya sisa yang bisa ditutup` };
  }
  const items = Array.isArray(po.items) ? po.items : [];
  if (!items.some((it) => (Number(it.qtyReceived) || 0) > 0)) {
    return { ok: false, status: 400, error: 'PO belum ada penerimaan — gunakan batal PO, bukan tutup sisa' };
  }

  const now = new Date();
  const closedLines: Array<{ lineId?: string; nama?: string; satuan?: string; qtyClosed: number }> = [];
  const nextItems: CpoLine[] = items.map((line) => {
    const remaining = poLineRemaining(line);
    if (!(remaining > 0)) return line;
    closedLines.push({
      lineId: line.lineId ? String(line.lineId) : undefined,
      nama: String(line.nama || line.kode || ''),
      satuan: line.satuan ? String(line.satuan) : undefined,
      qtyClosed: remaining,
    });
    const next: CpoLine = {
      ...line,
      qtyShortClosed: roundQty((Number(line.qtyShortClosed) || 0) + remaining),
      shortClosedAt: now,
    };
    return { ...next, qtyBackorder: lineBackorderQty(next) };
  });
  if (!closedLines.length) return { ok: false, status: 400, error: 'Tidak ada sisa qty PO yang terbuka' };

  const nextStatus = pickForwardCpoStatus(status, rollupCpoProgressStatus(nextItems));
  const ver = Number(po.qtySyncVersion) || 0;
  const res = await db.collection('customer_purchase_orders').updateOne(
    {
      id: input.poId,
      status,
      $and: [
        tenantIdMatchFilter(input.tenantId),
        { $or: [{ qtySyncVersion: ver }, ...(ver === 0 ? [{ qtySyncVersion: { $exists: false } }] : [])] },
      ],
    },
    {
      $set: {
        items: nextItems,
        status: nextStatus,
        hasBackorder: nextItems.some((it) => (Number(it.qtyBackorder) || 0) > 0),
        shortClosedAt: now,
        shortClosedBy: { userId: input.actor.userId, userName: input.actor.userName, role: input.actor.role || null },
        shortCloseReason: reason,
        updatedAt: now,
        qtySyncVersion: ver + 1,
      },
    },
    txOpts(session),
  );
  if (res.matchedCount === 0) return { ok: false, status: 409, error: 'PO berubah bersamaan — muat ulang lalu coba lagi' };

  await writeAuditLog(db, {
    tenantId: input.tenantId,
    action: 'CPO_SHORT_CLOSED',
    entityType: 'customer_purchase_order',
    entityId: input.poId,
    userId: input.actor.userId,
    userName: input.actor.userName,
    summary: `Tutup sisa PO ${po.noPO || input.poId}: ${closedLines.length} baris — ${reason}`,
    metadata: { noPO: po.noPO, fromStatus: status, toStatus: nextStatus, reason, lines: closedLines },
  }, session);

  return { ok: true, poId: input.poId, noPO: String(po.noPO || ''), status: nextStatus, lines: closedLines };
}
