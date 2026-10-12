/**
 * Baris SO vendor (sales.app) yang tidak ada di PO customer.
 *
 * Vendor bisa menambah barang ke SO yang tertaut PO (mis. barang yang dipindah dari vendor lain).
 * Barang itu dikirim, diterima (GRN) dan ditagih — maka PO wajib mengenalnya: tanpa baris PO,
 * 3-way match selalu EXCEPTION "tidak ada di PO" dan approval tagihan macet.
 *
 * Alur: hanya dari SO yang sudah mengikat (dikonfirmasi vendor, bukan DRAFT). Baris tambahan masuk PO
 * (`addedFromVendorSo`) berstatus menunggu persetujuan, ditautkan ke baris PO lain yang dibatalkan
 * karena barang yang sama pindah vendor (`relocatedFrom` / `relocatedTo`), kebijakan auto-terima
 * diterapkan (lib/api/cpo-vendor-line-acceptance), purchasing diberi notifikasi, lalu 3-way match
 * tagihan PENDING_REVIEW pada PO itu dihitung ulang.
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { findMatchingGrnLine, findMatchingVendorWebhookLine, type LocalPoLineLike } from '@/lib/uom/match-vendor-line';
import { roundQty } from '@/lib/stock-ledger/precision';
import { resolveProductByKode } from '@/lib/api/resolve-product-by-kode';
import { resolveLocalUomForGrnLine } from '@/lib/api/grn-from-webhook';
import { invoicePayloadFromHutang } from '@/lib/api/hutang-approval';
import { validateInvoiceAgainstGrn } from '@/lib/api/three-way-match';
import { computeHutangFromInvoice, hutangMatchVerdict, type HutangTaxLine, type HutangTaxPayload } from '@/lib/api/hutang-tax';
import { postVendorHutangJournal } from '@/lib/api/hutang-vendor-journal';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { writeAuditLog } from '@/lib/api/audit-log';
import { logger } from '@/lib/api/logger';
import { resolveRecipients, notifyUsers } from '@/lib/notifications/notify';
import { PO_APPROVAL_NOTIFY_ROLES } from '@/lib/api/customer-po-notify';
import { applyVendorLineAcceptancePolicy, type PolicyOutcome } from '@/lib/api/cpo-vendor-line-acceptance';
import type { ProductUom } from '@/lib/uom/types';
import type { HutangDoc } from '@/types/documents';
import type { JsonObject } from '@/types/json';

export const CPO_COLLECTION = 'customer_purchase_orders';
/** Alasan pembatalan otomatis dari diff SO (`diffPoItemsAgainstActiveSo`). */
export const NOT_IN_SO_REASON = 'Tidak ada di SO';
/** Jendela waktu pencarian pasangan perpindahan baris antar PO. */
export const RELOCATION_WINDOW_DAYS = 14;

export type PoLine = JsonObject & {
  lineId?: string;
  localStokId?: string | null;
  vendorStokId?: string;
  vendorTenantId?: string;
  vendorKode?: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  uomId?: string | null;
  vendorUomId?: string;
  qty?: number | string;
  qtyReceived?: number;
  cancelled?: boolean;
  cancelReason?: string;
  cancelledAt?: Date | string;
  addedFromVendorSo?: boolean;
  relocatedFrom?: LineRef;
  relocatedTo?: LineRef;
};

export type LineRef = {
  poId: string;
  noPO: string;
  lineId: string;
  vendorTenantId?: string;
  at: Date;
};

type SoItem = JsonObject & {
  lineId?: string;
  stokId?: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  uomId?: string;
  qty?: number | string;
  qtyOrdered?: number | string;
  qtyBase?: number | string;
  factorToBase?: number;
  harga?: number | string;
  cancelled?: boolean;
  outsidePo?: boolean;
};

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function num(v: unknown): number {
  return parseFloat(String(v ?? 0)) || 0;
}

function soItemQty(item: SoItem): number {
  return num(item.qty ?? item.qtyOrdered);
}

const UNCOMMITTED_SO_STATUSES = new Set(['', 'DRAFT', 'CANCELLED']);

/**
 * SO DRAFT masih bisa diubah vendor — baris tambahannya belum usulan resmi. Event confirmed selalu
 * mengikat; event lain memakai `soStatus` (webhook) / `status` (pull). Payload tanpa status
 * (Sales versi lama) tidak dianggap mengikat — pull-sync/rekonsiliasi yang menyusul.
 */
export function isVendorSoCommitted(event: string | null, status: unknown): boolean {
  if (event === 'sales_order.confirmed') return true;
  return !UNCOMMITTED_SO_STATUSES.has(str(status).toUpperCase());
}

/**
 * Item SO aktif milik vendor yang tidak cocok dengan baris PO mana pun (termasuk baris yang
 * dibatalkan — diff SO memulihkannya bila cocok lagi). Urutan pencocokan sama dengan diff SO.
 */
export function findExtraSoItems(
  poItems: PoLine[],
  soItems: SoItem[],
  scope: { vendorTenantId: string; multiVendor: boolean },
): SoItem[] {
  const vendor = str(scope.vendorTenantId);
  if (!vendor || !soItems.length) return [];
  const scoped = poItems.filter((l) => {
    const lv = str(l.vendorTenantId);
    return lv ? lv === vendor : !scope.multiVendor;
  });
  const used = new Set<number>();
  for (const line of scoped) {
    findMatchingVendorWebhookLine(line as LocalPoLineLike, soItems, used);
  }
  return soItems.filter((s, i) => !used.has(i) && s.cancelled !== true && soItemQty(s) > 0);
}

/** Baris PO baru dari item SO vendor; `lineId` = lineId SO agar sinkron berikutnya cocok (idempoten). */
export function buildExtraPoLine(
  item: SoItem,
  resolved: {
    localStokId?: string | null;
    localKode?: string | null;
    localNama?: string | null;
    uomId?: string;
    satuan?: string;
    factorToBase?: number;
  },
  meta: { vendorTenantId: string; salesOrderId?: string; noSO?: string },
  now: Date,
): PoLine {
  const qty = soItemQty(item);
  const harga = Math.round(num(item.harga));
  const localStokId = resolved.localStokId ? String(resolved.localStokId) : null;
  return {
    lineId: str(item.lineId) || uuidv4(),
    localStokId,
    vendorStokId: item.stokId ? String(item.stokId) : undefined,
    vendorTenantId: meta.vendorTenantId,
    vendorKode: str(item.kode),
    kode: str(resolved.localKode) || str(item.kode),
    nama: str(resolved.localNama) || str(item.nama),
    satuan: resolved.satuan || (item.satuan ? String(item.satuan) : undefined),
    uomId: resolved.uomId ?? null,
    vendorUomId: item.uomId ? String(item.uomId) : undefined,
    qty,
    ...(resolved.factorToBase != null || item.factorToBase != null
      ? { factorToBase: resolved.factorToBase ?? item.factorToBase }
      : {}),
    estimasiHarga: harga,
    hargaBeliReferensi: 0,
    estimasiJumlah: Math.round(qty * harga),
    qtyShipped: 0,
    qtyReceived: 0,
    qtyRejected: 0,
    qtyBackorder: 0,
    addedFromVendorSo: true,
    addedSource: 'sales.app',
    addedAt: now,
    addedSoId: meta.salesOrderId || undefined,
    addedNoSO: meta.noSO || undefined,
    vendorLineAcceptance: { status: 'PENDING', at: now },
    ...(localStokId ? {} : { needsMapping: true }),
  };
}

type GrnSourcePo = {
  tenantId?: unknown;
  noPO?: unknown;
  appliedReceiveGrnIds?: unknown;
  appliedReverseGrnIds?: unknown;
};

/**
 * Baris yang ditambahkan setelah GRN-nya sudah diterapkan ke PO (sinkron SO terlambat / backfill)
 * tidak akan disentuh sinkron GRN lagi — isi qty dikirim/diterima dari GRN POSTED vendor itu.
 * Baris GRN yang sudah dipakai baris PO lain tidak dihitung dua kali.
 */
export async function fillAddedLinesFromAppliedGrns(
  db: Db,
  po: GrnSourcePo,
  existing: PoLine[],
  added: PoLine[],
): Promise<Array<{ lineId: string; grnNos: string[] }>> {
  const applied = Array.isArray(po.appliedReceiveGrnIds) ? (po.appliedReceiveGrnIds as unknown[]).map(String) : [];
  if (!added.length || !applied.length) return [];
  const reversed = new Set(Array.isArray(po.appliedReverseGrnIds) ? (po.appliedReverseGrnIds as unknown[]).map(String) : []);
  const vendors = [...new Set(added.map((l) => str(l.vendorTenantId)).filter(Boolean))];
  const grns = await db.collection('goods_receipts').find({
    tenantId: po.tenantId,
    noPO: po.noPO,
    status: 'POSTED',
    id: { $in: applied.filter((id) => !reversed.has(id)) },
    ...(vendors.length ? { vendorTenantId: { $in: vendors } } : {}),
  }).project({ id: 1, noGRN: 1, vendorTenantId: 1, items: 1 }).toArray();
  if (!grns.length) return [];

  const { grnQtyInPoUnit } = await import('@/lib/api/cpo-status-sync');
  const cache = new Map<string, ProductUom[]>();
  const totals = new Map<string, { received: number; rejected: number; grnNos: string[] }>();
  for (const g of grns) {
    const grnItems = (Array.isArray(g.items) ? g.items : []) as JsonObject[];
    const gv = str(g.vendorTenantId);
    const used = new Set<number>();
    for (const line of existing) {
      if (!gv || str(line.vendorTenantId) === gv) findMatchingGrnLine(line as LocalPoLineLike, grnItems, used);
    }
    for (const line of added) {
      if (gv && str(line.vendorTenantId) !== gv) continue;
      const recv = findMatchingGrnLine(line as LocalPoLineLike, grnItems, used);
      if (!recv) continue;
      const qty = await grnQtyInPoUnit(db, str(po.tenantId), line as JsonObject, recv, cache);
      if (!qty) continue;
      const t = totals.get(str(line.lineId)) || { received: 0, rejected: 0, grnNos: [] };
      t.received += qty.received;
      t.rejected += qty.rejected;
      t.grnNos.push(str(g.noGRN) || str(g.id));
      totals.set(str(line.lineId), t);
    }
  }
  const out: Array<{ lineId: string; grnNos: string[] }> = [];
  for (const line of added) {
    const t = totals.get(str(line.lineId));
    if (!t) continue;
    line.qtyReceived = roundQty(t.received);
    line.qtyRejected = roundQty(t.rejected);
    line.qtyShipped = roundQty(t.received + t.rejected);
    line.qtyBackorder = Math.max(0, roundQty(num(line.qty) - t.received - t.rejected));
    out.push({ lineId: str(line.lineId), grnNos: t.grnNos });
  }
  return out;
}

/**
 * Tambahkan baris SO di luar PO ke `items` (setelah diff SO). Produk lokal & satuan dipetakan
 * dengan resolver yang sama dengan GRN webhook; qty diterima diisi dari GRN yang sudah diterapkan
 * bila `po` diberikan. Mengembalikan baris yang baru ditambahkan.
 */
export async function appendExtraSoLines(
  db: Db,
  tenantId: string,
  items: PoLine[],
  soItems: SoItem[],
  meta: { vendorTenantId?: string; salesOrderId?: string; noSO?: string; multiVendor: boolean; po?: GrnSourcePo },
  now = new Date(),
): Promise<{ items: PoLine[]; added: PoLine[] }> {
  const vendorTenantId = str(meta.vendorTenantId);
  const extras = findExtraSoItems(items, soItems, { vendorTenantId, multiVendor: meta.multiVendor });
  if (!extras.length) return { items, added: [] };

  const uomsCache = new Map<string, ProductUom[]>();
  const added: PoLine[] = [];
  for (const item of extras) {
    const product = await resolveProductByKode(db, tenantId, vendorTenantId, {
      kode: item.kode ? String(item.kode) : undefined,
      stokId: item.stokId ? String(item.stokId) : undefined,
    });
    const uom = await resolveLocalUomForGrnLine(db, tenantId, product?.localStokId ?? null, item, uomsCache);
    added.push(buildExtraPoLine(item, {
      localStokId: product?.localStokId ?? null,
      localKode: product?.localKode ?? null,
      localNama: product?.localNama ?? null,
      uomId: uom.uomId,
      satuan: uom.satuan,
      factorToBase: uom.factorToBase,
    }, { vendorTenantId, salesOrderId: meta.salesOrderId, noSO: meta.noSO }, now));
  }
  if (meta.po) await fillAddedLinesFromAppliedGrns(db, meta.po, items, added);
  return { items: [...items, ...added], added };
}

function isAutoCancelledNotInSo(line: PoLine): boolean {
  return line.cancelled === true && str(line.cancelReason).includes(NOT_IN_SO_REASON);
}

function sameProduct(a: PoLine, b: PoLine): boolean {
  if (a.localStokId && b.localStokId) return String(a.localStokId) === String(b.localStokId);
  const ka = str(a.kode || a.vendorKode).toUpperCase();
  const kb = str(b.kode || b.vendorKode).toUpperCase();
  return !!ka && ka === kb;
}

function lineTime(line: PoLine, key: 'cancelledAt' | 'addedAt'): number {
  const v = line[key];
  const t = v ? new Date(v as string | Date).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export type RelocationPair = {
  from: { po: JsonObject; line: PoLine };
  to: { po: JsonObject; line: PoLine };
};

/**
 * Pasangkan baris PO yang dibatalkan "Tidak ada di SO" dengan baris tambahan vendor untuk produk
 * yang sama pada PO lain milik customer yang sama (dua arah, kandidat terdekat waktunya).
 */
export function pairRelocations(po: JsonObject, candidates: JsonObject[]): RelocationPair[] {
  const pairs: RelocationPair[] = [];
  const taken = new Set<string>();
  const key = (p: JsonObject, l: PoLine) => `${str(p.id)}:${str(l.lineId)}`;
  const items = (Array.isArray(po.items) ? po.items : []) as PoLine[];

  for (const line of items) {
    const wantTarget = isAutoCancelledNotInSo(line) && !line.relocatedTo;
    const wantSource = line.addedFromVendorSo === true && !line.cancelled && !line.relocatedFrom;
    if (!wantTarget && !wantSource) continue;

    let best: { po: JsonObject; line: PoLine; gap: number } | null = null;
    for (const other of candidates) {
      if (str(other.id) === str(po.id)) continue;
      for (const ol of (Array.isArray(other.items) ? other.items : []) as PoLine[]) {
        if (taken.has(key(other, ol)) || !sameProduct(line, ol)) continue;
        const match = wantTarget
          ? ol.addedFromVendorSo === true && !ol.cancelled && !ol.relocatedFrom
          : isAutoCancelledNotInSo(ol) && !ol.relocatedTo;
        if (!match) continue;
        const gap = wantTarget
          ? Math.abs(lineTime(ol, 'addedAt') - lineTime(line, 'cancelledAt'))
          : Math.abs(lineTime(line, 'addedAt') - lineTime(ol, 'cancelledAt'));
        if (gap > RELOCATION_WINDOW_DAYS * 86_400_000) continue;
        if (!best || gap < best.gap) best = { po: other, line: ol, gap };
      }
    }
    if (!best) continue;
    taken.add(key(best.po, best.line));
    pairs.push(wantTarget
      ? { from: { po, line }, to: { po: best.po, line: best.line } }
      : { from: { po: best.po, line: best.line }, to: { po, line } });
  }
  return pairs;
}

function ref(po: JsonObject, line: PoLine, now: Date): LineRef {
  return {
    poId: str(po.id),
    noPO: str(po.noPO),
    lineId: str(line.lineId),
    ...(line.vendorTenantId ? { vendorTenantId: String(line.vendorTenantId) } : {}),
    at: now,
  };
}

/** Cari & simpan tautan perpindahan baris untuk PO ini. Idempoten: baris yang sudah tertaut dilewati. */
export async function linkRelocatedLines(db: Db, po: JsonObject, now = new Date()): Promise<RelocationPair[]> {
  const items = (Array.isArray(po.items) ? po.items : []) as PoLine[];
  const needs = items.some((l) => (isAutoCancelledNotInSo(l) && !l.relocatedTo)
    || (l.addedFromVendorSo === true && !l.cancelled && !l.relocatedFrom));
  if (!needs) return [];

  const since = new Date(now.getTime() - RELOCATION_WINDOW_DAYS * 86_400_000);
  const candidates = await db.collection(CPO_COLLECTION).find({
    tenantId: po.tenantId,
    id: { $ne: po.id },
    updatedAt: { $gte: since },
    $or: [
      { items: { $elemMatch: { cancelled: true, cancelReason: { $regex: NOT_IN_SO_REASON }, relocatedTo: { $exists: false } } } },
      { items: { $elemMatch: { addedFromVendorSo: true, relocatedFrom: { $exists: false } } } },
    ],
  }).project({ id: 1, noPO: 1, tenantId: 1, items: 1, createdBy: 1, requestedBy: 1 }).limit(50).toArray() as JsonObject[];

  const pairs = pairRelocations(po, candidates);
  const linked: RelocationPair[] = [];
  for (const pair of pairs) {
    const ok = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
      const a = await txDb.collection(CPO_COLLECTION).updateOne(
        { id: pair.from.po.id, items: { $elemMatch: { lineId: pair.from.line.lineId, relocatedTo: { $exists: false } } } },
        { $set: { 'items.$[l].relocatedTo': ref(pair.to.po, pair.to.line, now), updatedAt: now }, $inc: { qtySyncVersion: 1 } },
        { arrayFilters: [{ 'l.lineId': pair.from.line.lineId }], ...txOpts(session) },
      );
      if (a.matchedCount === 0) return false;
      const b = await txDb.collection(CPO_COLLECTION).updateOne(
        { id: pair.to.po.id, items: { $elemMatch: { lineId: pair.to.line.lineId, relocatedFrom: { $exists: false } } } },
        { $set: { 'items.$[l].relocatedFrom': ref(pair.from.po, pair.from.line, now), updatedAt: now }, $inc: { qtySyncVersion: 1 } },
        { arrayFilters: [{ 'l.lineId': pair.to.line.lineId }], ...txOpts(session) },
      );
      if (b.matchedCount === 0) throw new Error('relocation_target_changed');
      await writeAuditLog(txDb, {
        tenantId: str(po.tenantId),
        action: 'CPO_LINE_RELOCATED',
        entityType: 'customer_purchase_order',
        entityId: str(pair.to.po.id),
        summary: `${str(pair.to.line.nama) || str(pair.to.line.kode)} dipindah dari PO ${str(pair.from.po.noPO)} ke PO ${str(pair.to.po.noPO)}`,
        metadata: {
          kode: pair.to.line.kode,
          from: ref(pair.from.po, pair.from.line, now),
          to: ref(pair.to.po, pair.to.line, now),
        },
        userName: 'System',
      }, session);
      return true;
    }).catch((e: unknown) => {
      logger.warn('cpo_line_relocation_link_failed', {
        poId: str(po.id),
        lineId: str(pair.to.line.lineId),
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    });
    if (ok) linked.push(pair);
  }
  return linked;
}

function vendorOf(line: PoLine): string {
  return str(line.vendorTenantId) || 'vendor';
}

function lineLabel(line: PoLine): string {
  return `${str(line.nama) || str(line.kode)} ${num(line.qty)} ${str(line.satuan)}`.trim();
}

/** Pesan notifikasi purchasing — pure, supaya isi pesan bisa diuji. */
export function buildVendorLineChangeMessage(
  po: JsonObject,
  added: PoLine[],
  relocations: RelocationPair[],
  outcome: PolicyOutcome = { accepted: [], pending: [] },
): { title: string; body: string } | null {
  if (!added.length && !relocations.length && !outcome.accepted.length) return null;
  const relocatedIds = new Set(relocations.map((r) => str(r.to.line.lineId)));
  const acceptedIds = new Map(outcome.accepted.map((a) => [str(a.line.lineId), a.mode]));
  const pendingIds = new Map(outcome.pending.map((p) => [str(p.line.lineId), p.reason]));
  const decision = (lineId: unknown): string => {
    const mode = acceptedIds.get(str(lineId));
    if (mode) return mode === 'AUTO_RELOCATION' ? ' — diterima otomatis (pindahan PO)' : ' — diterima otomatis (dalam toleransi)';
    const reason = pendingIds.get(str(lineId));
    return reason ? ` — MENUNGGU PERSETUJUAN: ${reason}` : '';
  };
  const lines: string[] = [];
  for (const r of relocations) {
    lines.push(`${lineLabel(r.to.line)}: dipindah dari PO ${str(r.from.po.noPO)} (${vendorOf(r.from.line)}) ke PO ${str(r.to.po.noPO)} (${vendorOf(r.to.line)})${decision(r.to.line.lineId)}`);
  }
  const listed = new Set<string>();
  for (const l of added) {
    if (relocatedIds.has(str(l.lineId))) continue;
    listed.add(str(l.lineId));
    lines.push(`${lineLabel(l)}: ditambahkan vendor ${vendorOf(l)} di luar PO${decision(l.lineId)}`);
  }
  for (const a of outcome.accepted) {
    const id = str(a.line.lineId);
    if (listed.has(id) || relocatedIds.has(id)) continue;
    lines.push(`${lineLabel(a.line as PoLine)}: barang tambahan vendor ${vendorOf(a.line as PoLine)}${decision(id)}`);
  }
  if (added.some((l) => l.needsMapping)) {
    lines.push('Sebagian barang belum terpetakan ke produk lokal — periksa Master Produk.');
  }
  lines.push(pendingIds.size
    ? 'Terima atau tolak baris yang menunggu di halaman PO — tagihan vendor untuk barang itu tertahan sampai diputuskan.'
    : 'Tagihan vendor untuk barang ini mengikuti baris PO tersebut.');
  return { title: `PO ${str(po.noPO)}: barang tambahan dari vendor`, body: lines.join('\n') };
}

async function notifyVendorLineChanges(
  db: Db,
  po: JsonObject,
  added: PoLine[],
  relocations: RelocationPair[],
  outcome: PolicyOutcome,
): Promise<void> {
  const msg = buildVendorLineChangeMessage(po, added, relocations, outcome);
  if (!msg) return;
  const tenantId = str(po.tenantId);
  const createdBy = (po.createdBy || {}) as JsonObject;
  const requestedBy = (po.requestedBy || {}) as JsonObject;
  const recipients = await resolveRecipients(db, tenantId, {
    roles: PO_APPROVAL_NOTIFY_ROLES,
    userIds: [str(createdBy.userId), str(requestedBy.userId)],
  });
  const keyLines = [
    ...added.map((l) => str(l.lineId)),
    ...relocations.map((r) => str(r.to.line.lineId)),
    ...outcome.accepted.map((a) => `${str(a.line.lineId)}:ok`),
  ].sort();
  await notifyUsers(db, {
    tenantId,
    recipients,
    type: 'PO_VENDOR_LINE_ADDED',
    title: msg.title,
    body: msg.body,
    link: `/pembelian-po?highlight=${encodeURIComponent(str(po.id))}`,
    severity: 'warning',
    dedupeKey: `po-vendor-line:${str(po.id)}:${[...new Set(keyLines)].join(',')}`,
    refType: 'customer_purchase_order',
    refId: str(po.id),
    telegramSendNow: false,
  });
}

/**
 * Hitung ulang 3-way match tagihan PENDING_REVIEW berstatus EXCEPTION pada PO ini (mis. setelah
 * baris PO ditambahkan). Yang kini cocok → MATCHED + jurnal tagihan (idempoten); yang masih gagal
 * hanya diperbarui alasannya. Tagihan dengan selisih header pajak tidak disentuh.
 */
export async function rematchPendingHutangForPo(
  db: Db,
  tenantId: string,
  noPO: string,
  opts: { vendorTenantId?: string } = {},
): Promise<{ checked: number; matched: string[] }> {
  if (!noPO) return { checked: 0, matched: [] };
  const rows = await db.collection('hutang').find({
    tenantId,
    noPO,
    referenceType: 'VENDOR_INVOICE',
    approvalStatus: 'PENDING_REVIEW',
    matchStatus: 'EXCEPTION',
    matchCode: { $ne: 'TAX_TOTAL_MISMATCH' },
    ...(opts.vendorTenantId ? { vendorTenantId: opts.vendorTenantId } : {}),
  }).limit(50).toArray() as unknown as HutangDoc[];

  const matched: string[] = [];
  for (const h of rows) {
    const grnMatch = await validateInvoiceAgainstGrn(db, tenantId, invoicePayloadFromHutang(h), { excludeHutangId: h.id });
    // Cek pajak header sama seperti saat tagihan dibuat — dulu tertutup oleh error 3-way match.
    const items = (Array.isArray(h.items) ? h.items : []) as HutangTaxLine[];
    const tax = computeHutangFromInvoice({ ...(h as unknown as HutangTaxPayload), items }, items, false);
    const verdict = hutangMatchVerdict(grnMatch, tax);
    const match = { ...grnMatch, ok: verdict.ok, error: verdict.error ?? grnMatch.error, code: verdict.code ?? grnMatch.code };
    const now = new Date();
    if (!match.ok) {
      if (match.error && match.error !== h.matchError) {
        await db.collection('hutang').updateOne(
          { id: h.id, approvalStatus: 'PENDING_REVIEW', matchStatus: 'EXCEPTION' },
          { $set: { matchError: match.error, matchCode: match.code || null, matchRecomputedAt: now } },
        );
      }
      continue;
    }
    const done = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
      const res = await txDb.collection('hutang').updateOne(
        { id: h.id, approvalStatus: 'PENDING_REVIEW', matchStatus: 'EXCEPTION' },
        {
          $set: {
            matchStatus: 'MATCHED',
            matchError: null,
            matchCode: null,
            matchGrnCount: match.grnCount || 0,
            grnValue: match.grnValue || 0,
            matchRecomputedAt: now,
            updatedAt: now,
          },
        },
        txOpts(session),
      );
      if (res.matchedCount === 0) return false;
      await postVendorHutangJournal(txDb, h, { userName: 'System' }, session);
      await writeAuditLog(txDb, {
        tenantId,
        action: 'HUTANG_REMATCHED',
        entityType: 'hutang',
        entityId: String(h.id),
        summary: `Tagihan ${h.noInvoice || h.noHutang} cocok setelah baris PO ${noPO} diperbarui`,
        metadata: { noPO, previousMatchError: h.matchError || null },
        userName: 'System',
      }, session);
      return true;
    }).catch((e: unknown) => {
      logger.warn('hutang_rematch_failed', { hutangId: h.id, error: e instanceof Error ? e.message : String(e) });
      return false;
    });
    if (done) matched.push(String(h.id));
  }
  return { checked: rows.length, matched };
}

/**
 * Langkah lanjutan setelah baris PO berubah karena sinkron SO vendor. Best-effort: kegagalan hanya
 * di-log, tidak pernah menggagalkan sinkron (rekonsiliasi harian menangkap sisanya).
 */
export async function afterCpoVendorLinesSynced(
  db: Db,
  poId: string,
  opts: { added?: PoLine[]; vendorTenantId?: string; itemsChanged?: boolean; source?: string } = {},
): Promise<void> {
  try {
    const po = await db.collection(CPO_COLLECTION).findOne({ id: poId }) as JsonObject | null;
    if (!po) return;
    if (opts.added?.length) {
      await writeAuditLog(db, {
        tenantId: str(po.tenantId),
        action: 'CPO_VENDOR_LINE_ADDED',
        entityType: 'customer_purchase_order',
        entityId: poId,
        summary: `${opts.added.length} barang SO vendor ditambahkan ke PO ${str(po.noPO)}`,
        metadata: {
          source: opts.source || 'sales.app',
          lines: opts.added.map((l) => ({
            lineId: l.lineId, kode: l.kode, vendorTenantId: l.vendorTenantId, qty: l.qty, qtyReceived: l.qtyReceived,
            noSO: l.addedNoSO, needsMapping: l.needsMapping === true,
          })),
        },
        userName: 'System',
      });
    }
    const relocations = await linkRelocatedLines(db, po);
    const outcome = await applyVendorLineAcceptancePolicy(db, poId);
    // Penautan relokasi bisa membuat baris tambahan di PO lain lolos auto-terima.
    const otherPos = [...new Set(relocations.map((r) => str(r.to.po.id)).filter((id) => id && id !== poId))];
    for (const otherId of otherPos) {
      const other = await applyVendorLineAcceptancePolicy(db, otherId);
      if (!other.accepted.length) continue;
      const otherPo = await db.collection(CPO_COLLECTION).findOne({ id: otherId }) as JsonObject | null;
      if (!otherPo) continue;
      await notifyVendorLineChanges(db, otherPo, [], [], other);
      await rematchPendingHutangForPo(db, str(otherPo.tenantId), str(otherPo.noPO));
    }
    await notifyVendorLineChanges(db, po, opts.added || [], relocations, outcome);
    if (opts.added?.length || opts.itemsChanged || outcome.accepted.length) {
      await rematchPendingHutangForPo(db, str(po.tenantId), str(po.noPO), { vendorTenantId: opts.vendorTenantId });
    }
  } catch (e) {
    logger.warn('cpo_vendor_lines_after_sync_failed', { poId, error: e instanceof Error ? e.message : String(e) });
  }
}
