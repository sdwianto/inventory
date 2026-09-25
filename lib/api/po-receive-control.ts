/**
 * Fase 3.4 — penerimaan tidak boleh melebihi sisa PO di luar toleransi,
 * kecuali ada alasan dan peran penyetuju.
 */

import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import { qtyGt, roundQty } from '@/lib/stock-ledger/precision';
import type { JsonObject } from '@/types/json';

export const PO_OVER_RECEIVE_TOLERANCE_SETTING = 'poOverReceiveTolerancePct';
export const PO_OVER_RECEIVE_TOLERANCE_MAX_PCT = 100;

const APPROVER_ROLES = new Set(['SUPERVISOR', 'ADMIN', 'MASTER', 'OWNER']);

export function normalizePoOverReceiveTolerancePct(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > PO_OVER_RECEIVE_TOLERANCE_MAX_PCT) return null;
  return Math.round(n * 100) / 100;
}

export async function getPoOverReceiveTolerancePct(db: Db, tenantId: string, session?: ClientSession): Promise<number> {
  const row = await db.collection('tenant_settings').findOne(
    { tenantId },
    { projection: { [PO_OVER_RECEIVE_TOLERANCE_SETTING]: 1 }, ...txOpts(session) },
  ) as Record<string, unknown> | null;
  return normalizePoOverReceiveTolerancePct(row?.[PO_OVER_RECEIVE_TOLERANCE_SETTING]) ?? 0;
}

export function poReceiveAllowedQty(remaining: number, tolerancePct: number): number {
  const rem = Math.max(0, remaining);
  const pct = Math.max(0, tolerancePct);
  return roundQty(rem * (1 + pct / 100));
}

export function poOverReceiveReasonOk(raw: unknown): boolean {
  return String(raw ?? '').trim().length >= 3;
}

export function poOverReceiveApprover(role: unknown): boolean {
  return APPROVER_ROLES.has(String(role || '').trim().toUpperCase());
}

function normUnit(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

/** Satuan dokumen sama bila uomId sama, atau teks satuan sama. */
export function poReceiveSameUnit(
  poLine: { uomId?: unknown; satuan?: unknown },
  grnLine: { uomId?: unknown; satuan?: unknown },
): boolean {
  const poUom = String(poLine.uomId ?? '').trim();
  const grnUom = String(grnLine.uomId ?? '').trim();
  if (poUom && grnUom && poUom === grnUom) return true;
  const poSat = normUnit(poLine.satuan);
  const grnSat = normUnit(grnLine.satuan);
  return Boolean(poSat && grnSat && poSat === grnSat);
}

/** Sisa yang masih harus diterima baik. Qty ditolak tidak mengurangi sisa; sisa yang ditutup (short-close) mengurangi. */
export function poLineRemaining(line: { qty?: unknown; qtyReceived?: unknown; qtyShortClosed?: unknown; cancelled?: unknown }): number {
  if (line.cancelled) return 0;
  const ordered = parseFloat(String(line.qty)) || 0;
  const received = parseFloat(String(line.qtyReceived)) || 0;
  const closed = Math.max(0, parseFloat(String(line.qtyShortClosed)) || 0);
  return Math.max(0, roundQty(ordered - closed - received));
}

export function poOverReceiveMessage(input: {
  label: string;
  incoming: number;
  allowed: number;
  remaining: number;
  tolerancePct: number;
}): string {
  return (
    `${input.label}: penerimaan ${input.incoming} melebihi sisa PO ${input.remaining} `
    + `(batas ${input.allowed}, toleransi ${input.tolerancePct}%). `
    + 'Isi alasan lebih terima, dan posting oleh Supervisor, Admin, Master, atau Owner.'
  );
}

type GrnQtyLine = JsonObject & { qtyReceived?: unknown; localNama?: unknown; vendorNama?: unknown; nama?: unknown };

/** Baris yang lolos karena persetujuan lebih-terima — dicatat di GRN dan audit. */
export type PoOverReceiveLine = {
  label: string;
  kind: 'OVER_QTY' | 'UNIT_UNCONVERTIBLE' | 'NOT_ON_PO';
  incoming: number;
  remaining?: number;
  allowed?: number;
};

/**
 * Tolak GRN yang menerima di atas sisa PO + toleransi tanpa alasan dan peran penyetuju.
 * PO tanpa baris (data lama) tidak diblokir.
 */
export async function assertGrnWithinPo(
  db: Db,
  session: ClientSession | undefined,
  input: {
    tenantId: string;
    noPO?: string | null;
    grnItems: GrnQtyLine[];
    poItems: JsonObject[];
    tolerancePct: number;
    overReceiveReason?: string | null;
    actorRole?: string | null;
    match: (poLine: JsonObject, grnItems: GrnQtyLine[], used: Set<number>) => GrnQtyLine | undefined;
    /** Diisi baris yang lolos karena persetujuan (untuk jejak audit). */
    approvedOver?: PoOverReceiveLine[];
  },
): Promise<string | null> {
  const noPO = String(input.noPO || '').trim();
  if (!noPO || !input.poItems.length) return null;
  const incoming = input.grnItems.filter((it) => (parseFloat(String(it.qtyReceived)) || 0) > 0);
  if (!incoming.length) return null;

  const approved = poOverReceiveReasonOk(input.overReceiveReason) && poOverReceiveApprover(input.actorRole);
  const approvedOver = input.approvedOver ?? [];
  const used = new Set<number>();
  for (const poLine of input.poItems) {
    if (poLine.cancelled) continue;
    const hit = input.match(poLine, incoming, used);
    if (!hit) continue;
    const label = String(hit.localNama || hit.vendorNama || hit.nama || poLine.kode || poLine.localStokId || 'Baris');
    const sameUnit = poReceiveSameUnit(poLine, hit as { uomId?: unknown; satuan?: unknown });
    let qty = parseFloat(String(hit.qtyReceived)) || 0;
    let remaining = poLineRemaining(poLine);
    if (!sameUnit) {
      if (poLine.qtyRemainingBase == null || hit.qtyReceivedBase == null) {
        if (approved) {
          approvedOver.push({ label, kind: 'UNIT_UNCONVERTIBLE', incoming: qty });
          continue;
        }
        return `${label}: satuan penerimaan berbeda dari PO dan tidak bisa dikonversi. Isi alasan lebih terima, dan posting oleh Supervisor, Admin, Master, atau Owner.`;
      }
      qty = parseFloat(String(hit.qtyReceivedBase)) || 0;
      remaining = parseFloat(String(poLine.qtyRemainingBase)) || 0;
    }
    const allowed = poReceiveAllowedQty(remaining, input.tolerancePct);
    if (!qtyGt(qty, allowed)) continue;
    if (approved) {
      approvedOver.push({ label, kind: 'OVER_QTY', incoming: qty, remaining, allowed });
      continue;
    }
    return poOverReceiveMessage({
      label, incoming: qty, allowed, remaining, tolerancePct: input.tolerancePct,
    });
  }

  const unmatched = incoming.filter((_, i) => !used.has(i));
  if (unmatched.length && !approved) {
    const label = String(unmatched[0].localNama || unmatched[0].vendorNama || unmatched[0].nama || 'Baris');
    return `${label} tidak ada di PO ${noPO}. Isi alasan lebih terima, dan posting oleh Supervisor, Admin, Master, atau Owner.`;
  }
  for (const it of unmatched) {
    approvedOver.push({
      label: String(it.localNama || it.vendorNama || it.nama || 'Baris'),
      kind: 'NOT_ON_PO',
      incoming: parseFloat(String(it.qtyReceived)) || 0,
    });
  }
  return null;
}
