/**
 * Peringatan H-1: PO yang datang besok (WIB) tapi masih punya item belum diadakan vendor
 * ETA pengadaan melewati tanggal kedatangan, atau belum ada info dari vendor. Jalan 07:00 & 15:00 WIB;
 * run sore hanya mengirim bila daftar item berisiko berubah (dedupe via hash).
 */

import { createHash } from 'crypto';
import type { Db } from 'mongodb';
import type { JsonObject } from '@/types/json';
import { getTenantFeatureFlags } from '@/lib/api/feature-flags';
import {
  arrivalDateRangeFilter,
  refreshPoVendorAvailability,
  wibDateKey,
} from '@/lib/api/cpo-vendor-availability';
import {
  buildPoAvailabilityView,
  REMOTE_AVAILABILITY_STATUSES,
  type PoItemAvailabilityView,
} from '@/lib/pembelian-po/vendor-availability-view';
import { notifyUsers, resolveRecipients } from '@/lib/notifications/notify';
import { logger } from '@/lib/api/logger';
import type { IntegrationClient } from '@/lib/integration/client';

const AVAILABILITY_MAX_AGE_MS = 30 * 60_000;
const SCAN_LIMIT = 500;
const IN_PROGRESS_WAIT_MS = 3_000;
export const PO_ARRIVAL_RISK_ROLES = ['SUPERVISOR', 'ADMIN'];
const MAX_ITEMS_IN_MESSAGE = 8;

export { wibDateKey };

function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

function formatDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${d} ${months[(m || 1) - 1]} ${y}`;
}

export type ArrivalRiskLine = {
  lineId: string;
  nama: string;
  satuan: string;
  kind: 'BELUM' | 'ETA_LEWAT' | 'TIDAK_DIKETAHUI';
  qty: number;
  eta: string | null;
};

/**
 * `includeUnknown`: item tanpa info vendor (SO belum ada, sales gagal dihubungi, baris tak terpetakan)
 * ikut diperingatkan — H-1 tanpa kepastian sama berisikonya dengan belum diadakan.
 */
export function collectArrivalRisk(
  po: JsonObject,
  items: PoItemAvailabilityView[],
  opts: { includeUnknown?: boolean } = {},
): ArrivalRiskLine[] {
  const poItems = new Map(
    ((Array.isArray(po.items) ? po.items : []) as JsonObject[]).map((it) => [String(it.lineId || ''), it]),
  );
  const out: ArrivalRiskLine[] = [];
  for (const a of items) {
    const src = poItems.get(a.lineId) || {};
    const base = { lineId: a.lineId, nama: String(src.nama || src.kode || a.lineId), satuan: String(src.satuan || '') };
    if (a.qtyBelum > 0) out.push({ ...base, kind: 'BELUM', qty: a.qtyBelum, eta: null });
    if (a.etaLewatKedatangan && a.qtyDiadakan > 0) {
      out.push({ ...base, kind: 'ETA_LEWAT', qty: a.qtyDiadakan, eta: a.etaDiadakan });
    }
    if (opts.includeUnknown && a.status === 'TIDAK_DIKETAHUI') {
      const remaining = Math.max(0, a.qtyOrdered - a.qtyTerkirim - a.qtyDibatalkan);
      if (remaining > 0) out.push({ ...base, kind: 'TIDAK_DIKETAHUI', qty: remaining, eta: null });
    }
  }
  return out;
}

export function arrivalRiskHash(lines: ArrivalRiskLine[]): string {
  const sig = lines
    .map((l) => `${l.lineId}:${l.kind}:${formatQty(l.qty)}:${l.eta ? wibDateKey(new Date(l.eta)) : ''}`)
    .sort()
    .join('|');
  return createHash('sha1').update(sig).digest('hex').slice(0, 12);
}

export function buildArrivalRiskMessage(
  noPO: string,
  arrivalKey: string,
  lines: ArrivalRiskLine[],
): { title: string; body: string } {
  const belum = lines.filter((l) => l.kind === 'BELUM');
  const late = lines.filter((l) => l.kind === 'ETA_LEWAT');
  const unknown = lines.filter((l) => l.kind === 'TIDAK_DIKETAHUI');
  const fmt = (l: ArrivalRiskLine) => {
    const qty = `${formatQty(l.qty)}${l.satuan ? ` ${l.satuan}` : ''}`;
    return l.kind === 'ETA_LEWAT' && l.eta
      ? `• ${l.nama} (${qty}, ETA ${formatDayLabel(wibDateKey(new Date(l.eta)))})`
      : `• ${l.nama} (${qty})`;
  };
  const section = (label: string, rows: ArrivalRiskLine[]) => {
    if (!rows.length) return '';
    const shown = rows.slice(0, MAX_ITEMS_IN_MESSAGE).map(fmt);
    if (rows.length > MAX_ITEMS_IN_MESSAGE) shown.push(`• +${rows.length - MAX_ITEMS_IN_MESSAGE} item lain`);
    return `${label}:\n${shown.join('\n')}`;
  };
  const parts = [
    section(`${belum.length} item belum diadakan vendor`, belum),
    section(`${late.length} item ETA lewat tanggal kedatangan`, late),
    section(`${unknown.length} item belum ada info ketersediaan dari vendor`, unknown),
  ].filter(Boolean);
  return {
    title: `PO ${noPO} datang besok — ada item berisiko`,
    body: `Kedatangan ${formatDayLabel(arrivalKey)}.\n${parts.join('\n\n')}\n\nHubungi vendor atau siapkan alternatif.`,
  };
}

export async function runPoArrivalRiskAlert(
  db: Db,
  payload: { tenantId?: string; allTenants?: boolean } = {},
  opts: { now?: Date; client?: Pick<IntegrationClient, 'getCustomerPoAvailability'> } = {},
): Promise<Record<string, unknown>> {
  const now = opts.now ?? new Date();
  const arrivalKey = wibDateKey(new Date(now.getTime() + 86_400_000));
  const filter: JsonObject = {
    status: { $in: [...REMOTE_AVAILABILITY_STATUSES] },
    ...arrivalDateRangeFilter(arrivalKey, arrivalKey),
  };
  if (!payload.allTenants && payload.tenantId && payload.tenantId !== 'system') {
    filter.tenantId = payload.tenantId;
  }
  const pos = await db.collection('customer_purchase_orders')
    .find(filter)
    .sort({ tenantId: 1, _id: 1 })
    .limit(SCAN_LIMIT + 1)
    .toArray() as JsonObject[];
  const truncated = pos.length > SCAN_LIMIT;
  if (truncated) {
    pos.length = SCAN_LIMIT;
    logger.warn('po_arrival_risk_truncated', { limit: SCAN_LIMIT, arrivalDate: arrivalKey });
  }

  const tenantEnabled = new Map<string, boolean>();
  const stats = { scanned: pos.length, atRisk: 0, notified: 0, deduped: 0, disabled: 0, failed: 0, telegramQueued: 0, truncated };

  for (const original of pos) {
    try {
      const r = await alertOne(db, original, arrivalKey, tenantEnabled, opts);
      if (r === 'disabled') stats.disabled += 1;
      else if (r !== 'ok') {
        stats.atRisk += 1;
        if (r.inserted > 0) stats.notified += 1;
        else stats.deduped += 1;
        stats.telegramQueued += r.telegramQueued;
      }
    } catch (e) {
      stats.failed += 1;
      logger.warn('po_arrival_risk_failed', { poId: original.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { arrivalDate: arrivalKey, ...stats };
}

async function alertOne(
  db: Db,
  original: JsonObject,
  arrivalKey: string,
  tenantEnabled: Map<string, boolean>,
  opts: { now?: Date; client?: Pick<IntegrationClient, 'getCustomerPoAvailability'> },
): Promise<'disabled' | 'ok' | { inserted: number; telegramQueued: number }> {
  const tenantId = String(original.tenantId || '');
  if (!tenantEnabled.has(tenantId)) {
    tenantEnabled.set(tenantId, (await getTenantFeatureFlags(db, tenantId)).poArrivalRiskAlert);
  }
  if (!tenantEnabled.get(tenantId)) return 'disabled';

  const now = opts.now ?? new Date();
  const refreshed = await refreshPoVendorAvailability(db, original, {
    now,
    maxAgeMs: AVAILABILITY_MAX_AGE_MS,
    client: opts.client,
  });
  let po = refreshed.po;
  // Refresh lain sedang berjalan: tunggu sebentar lalu baca hasil terbarunya.
  if (refreshed.skipped === 'in_progress') {
    await new Promise((r) => setTimeout(r, IN_PROGRESS_WAIT_MS));
    po = (await db.collection('customer_purchase_orders').findOne({ id: original.id, tenantId })) as JsonObject || po;
  }
  const view = buildPoAvailabilityView(po, now);
  const allUnsupported = view.vendors.length > 0 && view.vendors.every((v) => v.state === 'UNSUPPORTED');
  const lines = collectArrivalRisk(po, view.items, { includeUnknown: !allUnsupported });
  if (!lines.length) return 'ok';

  const createdBy = (po.createdBy || {}) as JsonObject;
  const requestedBy = (po.requestedBy || {}) as JsonObject;
  const recipients = await resolveRecipients(db, tenantId, {
    roles: PO_ARRIVAL_RISK_ROLES,
    userIds: [String(createdBy.userId || ''), String(requestedBy.userId || '')],
  });
  const noPO = String(po.noPO || po.id);
  const msg = buildArrivalRiskMessage(noPO, arrivalKey, lines);
  return notifyUsers(db, {
    tenantId,
    recipients,
    type: 'PO_ARRIVAL_RISK',
    title: msg.title,
    body: msg.body,
    link: `/pembelian-po?highlight=${encodeURIComponent(String(po.id))}`,
    severity: lines.some((l) => l.kind !== 'ETA_LEWAT') ? 'critical' : 'warning',
    dedupeKey: `po-h1:${String(po.id)}:${arrivalKey}:${arrivalRiskHash(lines)}`,
    refType: 'customer_purchase_order',
    refId: String(po.id),
    telegramSendNow: false,
  });
}
