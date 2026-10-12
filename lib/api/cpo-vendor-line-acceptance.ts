/**
 * Persetujuan baris PO yang ditambahkan vendor (`addedFromVendorSo`).
 *
 * Baris tambahan vendor adalah usulan perubahan PO — belum komitmen pembelian sampai diterima.
 * Selama PENDING / REJECTED baris itu tidak diakui 3-way match, jadi tagihannya tertahan.
 *
 * Auto-terima (kebijakan tenant, diubah MASTER — lihat handlers/tenants):
 * 1. Relokasi — barang yang sama dipindah dari PO lain customer ini (baris sumber dibatalkan
 *    "Tidak ada di SO"); qty tidak melebihi qty sumber dan harga dalam toleransi harga 3-way match.
 *    Permintaan barangnya sudah pernah disetujui, hanya vendornya berganti.
 * 2. Toleransi — total tambahan yang diterima otomatis pada PO ≤ min(% nilai PO awal, batas nominal).
 * Syarat keduanya: produk terpetakan ke master lokal dan harga vendor ada. Sisanya diputuskan
 * purchasing (PO_APPROVE_ROLES). Setiap keputusan diaudit dan dikirim ke vendor (tanda baris SO).
 */

import type { Db } from 'mongodb';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { writeAuditLog } from '@/lib/api/audit-log';
import { logger } from '@/lib/api/logger';
import { resolveProductByKode } from '@/lib/api/resolve-product-by-kode';
import {
  enqueueVendorLineDecisionPush,
  insertVendorLineDecisionOutbox,
} from '@/lib/api/vendor-line-decision-push';
import type { JsonObject } from '@/types/json';

const CPO_COLLECTION = 'customer_purchase_orders';

export type VendorLineAcceptanceStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';
export type VendorLineAcceptanceMode = 'AUTO_RELOCATION' | 'AUTO_TOLERANCE' | 'MANUAL';
export type VendorLineActor = { userId: string; userName: string; role: string };

export type VendorLineAcceptance = {
  status: VendorLineAcceptanceStatus;
  mode?: VendorLineAcceptanceMode;
  at: Date;
  by?: VendorLineActor;
  /** PENDING: kenapa tidak lolos auto-terima. REJECTED: alasan penolakan. */
  reason?: string;
  /** Nilai yang dibandingkan aturan auto-terima (bukti audit). */
  rule?: Record<string, unknown>;
};

type Line = JsonObject & {
  lineId?: string;
  addedFromVendorSo?: boolean;
  vendorLineAcceptance?: VendorLineAcceptance;
  cancelled?: boolean;
};

export const SYSTEM_POLICY_ACTOR: VendorLineActor = { userId: 'system', userName: 'Kebijakan auto-terima', role: 'SYSTEM' };

export const VENDOR_LINE_AUTO_ACCEPT_SETTING = 'vendorLineAutoAccept';
export const VENDOR_LINE_AUTO_ACCEPT_PCT_SETTING = 'vendorLineAutoAcceptPct';
export const VENDOR_LINE_AUTO_ACCEPT_MAX_VALUE_SETTING = 'vendorLineAutoAcceptMaxValue';
export const VENDOR_LINE_POLICY_SETTINGS = [
  VENDOR_LINE_AUTO_ACCEPT_SETTING,
  VENDOR_LINE_AUTO_ACCEPT_PCT_SETTING,
  VENDOR_LINE_AUTO_ACCEPT_MAX_VALUE_SETTING,
] as const;

export type VendorLinePolicy = { autoAccept: boolean; maxIncreasePct: number; maxIncreaseValue: number };
export const DEFAULT_VENDOR_LINE_POLICY: VendorLinePolicy = { autoAccept: true, maxIncreasePct: 5, maxIncreaseValue: 1_000_000 };
const MAX_INCREASE_PCT = 20;
const MAX_INCREASE_VALUE = 1_000_000_000_000;
export const REJECT_REASON_MIN = 10;

function num(v: unknown): number {
  return parseFloat(String(v ?? 0)) || 0;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function idr(n: number): string {
  return `Rp ${Math.round(n).toLocaleString('id-ID')}`;
}

/** Kosong → null (pakai default). Di luar rentang / bukan boolean → undefined (ditolak). */
export function normalizeVendorLineAutoAccept(v: unknown): boolean | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return undefined;
}

export function normalizeVendorLineAutoAcceptPct(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > MAX_INCREASE_PCT) return undefined;
  return Math.round(n * 100) / 100;
}

export function normalizeVendorLineAutoAcceptMaxValue(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[.\s]/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > MAX_INCREASE_VALUE) return undefined;
  return Math.round(n);
}

export function vendorLinePolicyFromSettings(row: Record<string, unknown> | null | undefined): VendorLinePolicy {
  const d = DEFAULT_VENDOR_LINE_POLICY;
  return {
    autoAccept: normalizeVendorLineAutoAccept(row?.[VENDOR_LINE_AUTO_ACCEPT_SETTING]) ?? d.autoAccept,
    maxIncreasePct: normalizeVendorLineAutoAcceptPct(row?.[VENDOR_LINE_AUTO_ACCEPT_PCT_SETTING]) ?? d.maxIncreasePct,
    maxIncreaseValue: normalizeVendorLineAutoAcceptMaxValue(row?.[VENDOR_LINE_AUTO_ACCEPT_MAX_VALUE_SETTING]) ?? d.maxIncreaseValue,
  };
}

export async function getVendorLinePolicy(db: Db, tenantId: string): Promise<VendorLinePolicy> {
  const row = await db.collection('tenant_settings').findOne(
    { tenantId },
    { projection: Object.fromEntries(VENDOR_LINE_POLICY_SETTINGS.map((k) => [k, 1])) },
  );
  return vendorLinePolicyFromSettings(row as Record<string, unknown> | null);
}

/** null = baris PO biasa (bukan tambahan vendor). Baris tambahan lama tanpa status = PENDING. */
export function vendorLineAcceptanceStatus(line: JsonObject): VendorLineAcceptanceStatus | null {
  if (line.addedFromVendorSo !== true) return null;
  const s = str((line.vendorLineAcceptance as JsonObject | undefined)?.status);
  return s === 'ACCEPTED' || s === 'REJECTED' ? s : 'PENDING';
}

export function isVendorLinePendingDecision(line: JsonObject): boolean {
  return line.cancelled !== true && vendorLineAcceptanceStatus(line) === 'PENDING';
}

function lineValue(line: JsonObject, qtyKey: 'qty' | 'qtyOriginal' = 'qty'): number {
  const qty = qtyKey === 'qtyOriginal' ? num(line.qtyOriginal ?? line.qty) : num(line.qty);
  return Math.round(qty * num(line.estimasiHarga));
}

/** Nilai PO yang disetujui = baris asli PO (termasuk yang kemudian dibatalkan), tanpa tambahan vendor. */
export function poApprovedBaseValue(items: JsonObject[]): number {
  return items
    .filter((l) => l.addedFromVendorSo !== true)
    .reduce((s, l) => s + (num(l.estimasiJumlah) > 0 ? num(l.estimasiJumlah) : lineValue(l, 'qtyOriginal')), 0);
}

function sameUnit(a: JsonObject, b: JsonObject): boolean {
  if (str(a.uomId) && str(b.uomId)) return str(a.uomId) === str(b.uomId);
  return !!str(a.satuan) && str(a.satuan).toUpperCase() === str(b.satuan).toUpperCase();
}

export type AutoAcceptVerdict =
  | { accept: true; mode: 'AUTO_RELOCATION' | 'AUTO_TOLERANCE'; rule: Record<string, unknown> }
  | { accept: false; reason: string };

/** Pure — keputusan auto-terima satu baris terhadap isi PO saat ini. */
export function evaluateVendorLineAutoAccept(input: {
  line: JsonObject;
  items: JsonObject[];
  policy: VendorLinePolicy;
  priceTolerancePct: number;
  relocationSource?: (JsonObject & { noPO?: string }) | null;
}): AutoAcceptVerdict {
  const { line, items, policy } = input;
  if (!policy.autoAccept) return { accept: false, reason: 'Auto-terima dinonaktifkan untuk tenant ini' };
  if (line.needsMapping === true || !str(line.localStokId)) {
    return { accept: false, reason: 'Produk vendor belum terpetakan ke master produk lokal' };
  }
  const price = num(line.estimasiHarga);
  if (!(price > 0)) return { accept: false, reason: 'Harga vendor untuk barang ini belum ada' };
  const qty = num(line.qty);
  const reasons: string[] = [];

  const src = input.relocationSource;
  if (src) {
    const srcQty = num(src.qtyOriginal ?? src.qty);
    const srcPrice = num(src.estimasiHarga);
    const maxPrice = srcPrice * (1 + input.priceTolerancePct / 100) + 1;
    if (!sameUnit(line, src)) reasons.push(`satuan berbeda dari baris asal PO ${str(src.noPO)}`);
    else if (qty > srcQty + 1e-9) reasons.push(`qty ${qty} melebihi qty asal ${srcQty} di PO ${str(src.noPO)}`);
    else if (!(srcPrice > 0)) reasons.push(`harga baris asal PO ${str(src.noPO)} tidak diketahui`);
    else if (price > maxPrice) {
      reasons.push(`harga ${idr(price)} di atas harga asal ${idr(srcPrice)} (+${input.priceTolerancePct}%)`);
    } else {
      return {
        accept: true,
        mode: 'AUTO_RELOCATION',
        rule: { fromNoPO: str(src.noPO), fromLineId: str(src.lineId), qty, fromQty: srcQty, price, fromPrice: srcPrice, priceTolerancePct: input.priceTolerancePct },
      };
    }
  }

  const value = lineValue(line);
  const base = poApprovedBaseValue(items);
  const used = items
    .filter((l) => l.addedFromVendorSo === true && l.cancelled !== true && str(l.lineId) !== str(line.lineId))
    .filter((l) => {
      const a = l.vendorLineAcceptance as VendorLineAcceptance | undefined;
      return a?.status === 'ACCEPTED' && a.mode === 'AUTO_TOLERANCE';
    })
    .reduce((s, l) => s + lineValue(l), 0);
  const limit = Math.min(Math.floor((base * policy.maxIncreasePct) / 100), policy.maxIncreaseValue);
  const rule = { value, used, base, pct: policy.maxIncreasePct, maxValue: policy.maxIncreaseValue, limit };
  if (limit > 0 && value > 0 && used + value <= limit) return { accept: true, mode: 'AUTO_TOLERANCE', rule };
  if (base <= 0) {
    reasons.push('nilai PO awal belum diketahui (harga estimasi baris PO kosong) — toleransi tidak bisa dihitung');
  } else if (value <= 0) {
    reasons.push('harga barang tambahan belum diketahui — toleransi tidak bisa dihitung');
  } else {
    reasons.push(
      `tambahan ${idr(value)}${used > 0 ? ` (+ ${idr(used)} sudah diterima otomatis)` : ''} melebihi batas auto-terima `
      + `${idr(limit)} (${policy.maxIncreasePct}% nilai PO ${idr(base)}, maks ${idr(policy.maxIncreaseValue)})`,
    );
  }
  const text = reasons.join('; ');
  return { accept: false, reason: text.charAt(0).toUpperCase() + text.slice(1) };
}

function lineLabel(line: JsonObject): string {
  return `${str(line.nama) || str(line.kode)} ${num(line.qty)} ${str(line.satuan)}`.trim();
}

const MODE_LABEL: Record<VendorLineAcceptanceMode, string> = {
  AUTO_RELOCATION: 'otomatis (pindahan dari PO lain)',
  AUTO_TOLERANCE: 'otomatis (dalam toleransi)',
  MANUAL: 'manual',
};

type DecisionPatch = {
  acceptance: VendorLineAcceptance;
  /** Field baris lain yang ikut berubah (mis. pembatalan saat ditolak, pemetaan produk). */
  lineSet?: Record<string, unknown>;
};

const PROGRESS_STATUSES = new Set(['CONFIRMED', 'PARTIAL_SHIPPED', 'SHIPPED', 'PARTIAL_RECEIVED']);

/**
 * Simpan keputusan satu baris: CAS qtySyncVersion (sama dengan sinkron GRN/kirim/short-close),
 * audit + intent push vendor dalam satu TX. false = baris sudah berubah (diputuskan pihak lain).
 */
async function commitDecision(
  db: Db,
  poId: string,
  lineId: string,
  patch: DecisionPatch,
): Promise<{ ok: true; po: JsonObject; line: JsonObject } | { ok: false; conflict: boolean }> {
  const { rollupCpoProgressStatus, pickForwardCpoStatus, lineBackorderQty } = await import('@/lib/api/cpo-status-sync');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const po = await db.collection(CPO_COLLECTION).findOne({ id: poId }) as JsonObject | null;
    if (!po) return { ok: false, conflict: false };
    const items = (Array.isArray(po.items) ? po.items : []) as Line[];
    const idx = items.findIndex((l) => str(l.lineId) === lineId);
    if (idx < 0 || !isVendorLinePendingDecision(items[idx])) return { ok: false, conflict: true };
    const nextLine: Line = { ...items[idx], ...(patch.lineSet || {}), vendorLineAcceptance: patch.acceptance };
    if (nextLine.cancelled !== true) {
      nextLine.qtyBackorder = lineBackorderQty(nextLine as Parameters<typeof lineBackorderQty>[0]);
    }
    const nextItems = items.map((l, i) => (i === idx ? nextLine : l));
    const status = str(po.status);
    const nextStatus = PROGRESS_STATUSES.has(status)
      ? pickForwardCpoStatus(status, rollupCpoProgressStatus(nextItems as Parameters<typeof rollupCpoProgressStatus>[0]))
      : status;
    const ver = Number(po.qtySyncVersion) || 0;
    const tenantId = str(po.tenantId) || 'default';
    const at = patch.acceptance.at;

    const done = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
      const res = await txDb.collection(CPO_COLLECTION).updateOne(
        {
          id: poId,
          status: po.status,
          $or: ver === 0 ? [{ qtySyncVersion: { $exists: false } }, { qtySyncVersion: 0 }] : [{ qtySyncVersion: ver }],
        },
        {
          $set: {
            items: nextItems,
            ...(nextStatus !== status ? { status: nextStatus } : {}),
            hasBackorder: nextItems.some((it) => num(it.qtyBackorder) > 0),
            updatedAt: at,
            qtySyncVersion: ver + 1,
          },
        },
        txOpts(session),
      );
      if (res.matchedCount === 0) return false;
      const a = patch.acceptance;
      const accepted = a.status === 'ACCEPTED';
      await writeAuditLog(txDb, {
        tenantId,
        action: accepted ? 'CPO_VENDOR_LINE_ACCEPTED' : 'CPO_VENDOR_LINE_REJECTED',
        entityType: 'customer_purchase_order',
        entityId: poId,
        summary: accepted
          ? `Barang tambahan vendor ${lineLabel(nextLine)} di PO ${str(po.noPO)} diterima ${a.mode ? MODE_LABEL[a.mode] : ''}`
            + (a.mode === 'MANUAL' ? ` oleh ${a.by?.userName || '-'}` : '')
          : `Barang tambahan vendor ${lineLabel(nextLine)} di PO ${str(po.noPO)} ditolak oleh ${a.by?.userName || '-'}: ${a.reason || ''}`,
        metadata: {
          lineId,
          kode: nextLine.kode,
          vendorTenantId: nextLine.vendorTenantId,
          qty: nextLine.qty,
          estimasiHarga: nextLine.estimasiHarga,
          noSO: nextLine.addedNoSO,
          mode: a.mode,
          reason: a.reason || null,
          rule: a.rule || null,
          ...(nextStatus !== status ? { status: { from: status, to: nextStatus } } : {}),
        },
        userId: a.by?.userId,
        userName: a.by?.userName || 'System',
      }, session);
      await insertVendorLineDecisionOutbox(txDb, tenantId, {
        poId,
        noPO: str(po.noPO),
        lineId,
        vendorTenantId: str(nextLine.vendorTenantId),
        salesOrderId: str(nextLine.addedSoId) || null,
        noSO: str(nextLine.addedNoSO) || null,
        kode: str(nextLine.vendorKode) || str(nextLine.kode) || null,
        decision: accepted ? 'ACCEPTED' : 'REJECTED',
        mode: a.mode || 'MANUAL',
        reason: a.reason || null,
        decidedBy: a.by?.userName || null,
        decidedAt: at.toISOString(),
      }, session);
      return true;
    });
    if (done) return { ok: true, po: { ...po, items: nextItems, status: nextStatus }, line: nextLine };
  }
  return { ok: false, conflict: true };
}

async function loadRelocationSource(db: Db, line: JsonObject): Promise<(JsonObject & { noPO?: string }) | null> {
  const ref = line.relocatedFrom as JsonObject | undefined;
  if (!ref?.poId || !ref.lineId) return null;
  const doc = await db.collection(CPO_COLLECTION).findOne({ id: String(ref.poId) }, { projection: { noPO: 1, items: 1 } });
  const srcLine = ((doc?.items as JsonObject[] | undefined) || []).find((l) => str(l.lineId) === str(ref.lineId));
  return srcLine ? { ...srcLine, noPO: str(doc?.noPO) } : null;
}

export type PolicyOutcome = {
  accepted: Array<{ line: JsonObject; mode: VendorLineAcceptanceMode }>;
  pending: Array<{ line: JsonObject; reason: string }>;
};

/**
 * Terapkan kebijakan auto-terima pada baris tambahan vendor yang masih PENDING (idempoten: baris
 * yang sudah diputuskan dilewati). Dipanggil setelah sinkron SO / penautan relokasi / backfill.
 */
export async function applyVendorLineAcceptancePolicy(db: Db, poId: string, now = new Date()): Promise<PolicyOutcome> {
  const out: PolicyOutcome = { accepted: [], pending: [] };
  const po = await db.collection(CPO_COLLECTION).findOne({ id: poId }) as JsonObject | null;
  if (!po || ['CANCELLED', 'REJECTED'].includes(str(po.status))) return out;
  const items = (Array.isArray(po.items) ? po.items : []) as Line[];
  const pending = items.filter(isVendorLinePendingDecision)
    .sort((a, b) => new Date(String(a.addedAt || 0)).getTime() - new Date(String(b.addedAt || 0)).getTime());
  if (!pending.length) return out;

  const tenantId = str(po.tenantId) || 'default';
  const { getThreeWayTolerances } = await import('@/lib/api/three-way-match');
  const [policy, tol] = await Promise.all([getVendorLinePolicy(db, tenantId), getThreeWayTolerances(db, tenantId)]);
  let working: JsonObject[] = items;
  for (const line of pending) {
    const lineId = str(line.lineId);
    const verdict = evaluateVendorLineAutoAccept({
      line,
      items: working,
      policy,
      priceTolerancePct: tol.priceTolerancePct,
      relocationSource: await loadRelocationSource(db, line),
    });
    if (verdict.accept) {
      const res = await commitDecision(db, poId, lineId, {
        acceptance: { status: 'ACCEPTED', mode: verdict.mode, at: now, by: SYSTEM_POLICY_ACTOR, rule: verdict.rule },
      });
      if (res.ok) {
        out.accepted.push({ line: res.line, mode: verdict.mode });
        working = (res.po.items as JsonObject[]) || working;
      }
      continue;
    }
    const prev = line.vendorLineAcceptance;
    if (prev?.reason !== verdict.reason) {
      await db.collection(CPO_COLLECTION).updateOne(
        { id: poId, items: { $elemMatch: { lineId, cancelled: { $ne: true }, 'vendorLineAcceptance.status': { $nin: ['ACCEPTED', 'REJECTED'] } } } },
        {
          $set: { 'items.$[l].vendorLineAcceptance': { status: 'PENDING', at: prev?.at || now, reason: verdict.reason } },
          $inc: { qtySyncVersion: 1 },
        },
        { arrayFilters: [{ 'l.lineId': lineId }] },
      );
    }
    out.pending.push({ line, reason: verdict.reason });
  }
  if (out.accepted.length) {
    await enqueueVendorLineDecisionPush(db, tenantId, poId, `vendor-line-decision:${poId}:${out.accepted.map((a) => str(a.line.lineId)).sort().join(',')}`);
  }
  return out;
}

export type DecideVendorLineResult =
  | { ok: true; po: JsonObject; line: JsonObject }
  | { ok: false; status: number; error: string; code?: string };

/** Keputusan manual purchasing (PO_APPROVE_ROLES dicek di handler). */
export async function decideVendorLine(
  db: Db,
  input: {
    tenantId: string;
    poId: string;
    lineId: string;
    decision: 'ACCEPTED' | 'REJECTED';
    reason?: string;
    actor: VendorLineActor;
  },
  now = new Date(),
): Promise<DecideVendorLineResult> {
  const po = await db.collection(CPO_COLLECTION).findOne({ id: input.poId, tenantId: input.tenantId }) as JsonObject | null;
  if (!po) return { ok: false, status: 404, error: 'PO tidak ditemukan' };
  if (['CANCELLED', 'REJECTED'].includes(str(po.status))) {
    return { ok: false, status: 400, error: `PO berstatus ${str(po.status)} — baris tidak bisa diputuskan` };
  }
  const line = ((po.items as Line[] | undefined) || []).find((l) => str(l.lineId) === input.lineId);
  if (!line || line.addedFromVendorSo !== true) return { ok: false, status: 404, error: 'Baris tambahan vendor tidak ditemukan' };
  const decided = (line.vendorLineAcceptance as VendorLineAcceptance | undefined)?.status;
  if (decided === 'ACCEPTED' || decided === 'REJECTED') {
    return { ok: false, status: 409, error: `Baris sudah ${decided === 'ACCEPTED' ? 'diterima' : 'ditolak'}`, code: 'VENDOR_LINE_DECIDED' };
  }
  if (line.cancelled === true) return { ok: false, status: 400, error: 'Baris sudah dibatalkan' };
  const current = vendorLineAcceptanceStatus(line);
  if (current !== 'PENDING') {
    return { ok: false, status: 409, error: `Baris sudah ${current === 'ACCEPTED' ? 'diterima' : 'ditolak'}`, code: 'VENDOR_LINE_DECIDED' };
  }
  const reason = str(input.reason).slice(0, 500);
  const lineSet: Record<string, unknown> = {};

  if (input.decision === 'REJECTED') {
    if (reason.length < REJECT_REASON_MIN) {
      return { ok: false, status: 400, error: `Alasan penolakan minimal ${REJECT_REASON_MIN} karakter` };
    }
    if (num(line.qtyShipped) > 0 || num(line.qtyReceived) > 0) {
      return {
        ok: false,
        status: 400,
        code: 'VENDOR_LINE_ALREADY_SHIPPED',
        error: 'Barang ini sudah dikirim/diterima — terima barisnya, lalu proses retur vendor bila memang tidak dikehendaki',
      };
    }
    const qty = num(line.qty);
    Object.assign(lineSet, {
      cancelled: true,
      qtyOriginal: num(line.qtyOriginal ?? qty),
      qtyCancelled: qty,
      cancelledAt: now,
      cancelReason: `Ditolak purchasing: ${reason}`,
      cancelledSource: 'purchasing_rejected',
      qtyBackorder: 0,
    });
  } else if (!str(line.localStokId)) {
    const product = await resolveProductByKode(db, input.tenantId, str(line.vendorTenantId), {
      kode: str(line.vendorKode) || str(line.kode) || undefined,
      stokId: str(line.vendorStokId) || undefined,
    });
    if (!product?.localStokId) {
      return {
        ok: false,
        status: 400,
        code: 'VENDOR_LINE_UNMAPPED',
        error: 'Produk vendor belum terpetakan ke master produk lokal — petakan di Master Produk dulu',
      };
    }
    Object.assign(lineSet, {
      localStokId: String(product.localStokId),
      ...(product.localKode ? { kode: String(product.localKode) } : {}),
      ...(product.localNama ? { nama: String(product.localNama) } : {}),
      needsMapping: false,
    });
  }

  const res = await commitDecision(db, input.poId, input.lineId, {
    acceptance: {
      status: input.decision,
      mode: 'MANUAL',
      at: now,
      by: input.actor,
      ...(reason ? { reason } : {}),
    },
    lineSet,
  });
  if (!res.ok) {
    return res.conflict
      ? { ok: false, status: 409, error: 'Baris berubah bersamaan — muat ulang lalu coba lagi', code: 'CAS_CONFLICT' }
      : { ok: false, status: 404, error: 'PO tidak ditemukan' };
  }

  await enqueueVendorLineDecisionPush(db, input.tenantId, input.poId, `vendor-line-decision:${input.poId}:${input.lineId}`);
  try {
    const { rematchPendingHutangForPo } = await import('@/lib/api/cpo-extra-so-lines');
    await rematchPendingHutangForPo(db, input.tenantId, str(po.noPO), { vendorTenantId: str(line.vendorTenantId) || undefined });
  } catch (e) {
    logger.warn('vendor_line_decision_rematch_failed', { poId: input.poId, error: e instanceof Error ? e.message : String(e) });
  }
  return { ok: true, po: res.po, line: res.line };
}
