import type { Db } from 'mongodb';
// 3-way match: Invoice vendor vs GRN POSTED — per kode + UOM (P1.3a).

import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import type {
  ThreeWayMatchOptions,
  ThreeWayMatchResult,
  VendorInvoiceLine,
  VendorInvoicePayload,
} from '@/types/integration';
import { qtyGt } from '@/lib/stock-ledger/precision';
import { resolveSoSnapshotForPo } from '@/lib/api/hutang-variance-enrich';
import type { HutangDoc } from '@/types/documents';
import type { JsonObject } from '@/types/json';

export const DEFAULT_QTY_TOLERANCE_PCT = 0;
export const DEFAULT_PRICE_TOLERANCE_PCT = 2;
export const THREE_WAY_QTY_TOLERANCE_SETTING = 'threeWayQtyTolerancePct';
export const THREE_WAY_PRICE_TOLERANCE_SETTING = 'threeWayPriceTolerancePct';
const THREE_WAY_TOLERANCE_MAX_PCT = 20;

/** 0–20 (%). Kosong → default; di luar rentang → null (ditolak). */
export function normalizeThreeWayTolerancePct(value: unknown, fallback: number): number | null {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > THREE_WAY_TOLERANCE_MAX_PCT) return null;
  return Math.round(n * 100) / 100;
}

export async function getThreeWayTolerances(
  db: Db,
  tenantId: string,
): Promise<{ qtyTolerancePct: number; priceTolerancePct: number }> {
  const row = await db.collection('tenant_settings').findOne(
    { tenantId },
    { projection: { [THREE_WAY_QTY_TOLERANCE_SETTING]: 1, [THREE_WAY_PRICE_TOLERANCE_SETTING]: 1 } },
  ) as Record<string, unknown> | null;
  return {
    qtyTolerancePct: normalizeThreeWayTolerancePct(row?.[THREE_WAY_QTY_TOLERANCE_SETTING], DEFAULT_QTY_TOLERANCE_PCT)
      ?? DEFAULT_QTY_TOLERANCE_PCT,
    priceTolerancePct: normalizeThreeWayTolerancePct(row?.[THREE_WAY_PRICE_TOLERANCE_SETTING], DEFAULT_PRICE_TOLERANCE_PCT)
      ?? DEFAULT_PRICE_TOLERANCE_PCT,
  };
}

interface GrnItemRow {
  lineId?: string;
  vendorKode?: string;
  localKode?: string;
  localStokId?: string;
  stokId?: string;
  uomId?: string;
  satuan?: string;
  qtyReceived?: number | string;
  harga?: number | string;
  hargaBeliBaru?: number | string;
}

interface GrnRow {
  items?: GrnItemRow[];
}

export function lineMatchKey(
  kode: string,
  uomId?: string | null,
  satuan?: string | null,
  stokId?: string | null,
): string {
  const productKey = String(stokId || kode || '').trim();
  const uom = String(uomId || satuan || '').trim() || '_default';
  return `${productKey}::${uom}`;
}

function grnLineProductKey(it: GrnItemRow): string {
  return String(it.localStokId || it.stokId || it.vendorKode || it.localKode || '').trim();
}

function invoiceLineProductKey(invLine: { kode?: string; stokId?: string }): string {
  return String(invLine.stokId || invLine.kode || '').trim();
}

function normalizeKode(kode?: string | null): string {
  return String(kode || '').trim().toUpperCase();
}

function normalizeSatuan(satuan?: string | null): string {
  return String(satuan || '').trim().toUpperCase();
}

function kodeSatuanKey(kode?: string | null, satuan?: string | null): string {
  const k = normalizeKode(kode);
  const s = normalizeSatuan(satuan);
  if (!k || !s) return '';
  return `${k}::${s}`;
}

/** Subtotal invoice untuk dibandingkan ke nilai GRN (tanpa PPN). */
export function invoiceComparableSubTotal(payload: VendorInvoicePayload): number {
  const sub = parseInt(String(payload.subTotal ?? 0), 10);
  if (sub > 0) return sub;
  const total = parseInt(String(payload.total || 0), 10);
  const ppn = parseInt(String(payload.ppn || 0), 10);
  return Math.max(0, total - ppn);
}

type PriceBucket = { qty: number; value: number };

type GrnReceivedIndex = {
  receivedByKey: Map<string, number>;
  receivedByLineId: Map<string, number>;
  receivedByKodeSatuan: Map<string, number>;
  receivedByKodeLegacy: Map<string, number>;
  priceByKey: Map<string, PriceBucket>;
  priceByLineId: Map<string, PriceBucket>;
  priceByKodeSatuan: Map<string, PriceBucket>;
  priceByKodeLegacy: Map<string, PriceBucket>;
  grnValue: number;
};

function addPrice(map: Map<string, PriceBucket>, key: string, qty: number, harga: number) {
  if (!key || !(qty > 0)) return;
  const bucket = map.get(key) || { qty: 0, value: 0 };
  bucket.qty += qty;
  bucket.value += qty * harga;
  map.set(key, bucket);
}

function buildGrnReceivedIndex(grns: GrnRow[]): GrnReceivedIndex {
  const receivedByKey = new Map<string, number>();
  const receivedByLineId = new Map<string, number>();
  const receivedByKodeSatuan = new Map<string, number>();
  const receivedByKodeLegacy = new Map<string, number>();
  const priceByKey = new Map<string, PriceBucket>();
  const priceByLineId = new Map<string, PriceBucket>();
  const priceByKodeSatuan = new Map<string, PriceBucket>();
  const priceByKodeLegacy = new Map<string, PriceBucket>();
  let grnValue = 0;

  for (const grn of grns) {
    for (const it of grn.items || []) {
      const kode = String(it.vendorKode || it.localKode || '');
      const productKey = grnLineProductKey(it);
      const qty = parseFloat(String(it.qtyReceived)) || 0;
      const harga = parseInt(String(it.harga || it.hargaBeliBaru || 0), 10);
      const key = lineMatchKey(kode, it.uomId, it.satuan, productKey);
      receivedByKey.set(key, (receivedByKey.get(key) || 0) + qty);
      if (it.lineId) {
        receivedByLineId.set(String(it.lineId), (receivedByLineId.get(String(it.lineId)) || 0) + qty);
      }
      const ks = kodeSatuanKey(kode, it.satuan);
      if (ks) {
        receivedByKodeSatuan.set(ks, (receivedByKodeSatuan.get(ks) || 0) + qty);
      }
      if (kode) {
        receivedByKodeLegacy.set(kode, (receivedByKodeLegacy.get(kode) || 0) + qty);
      }
      addPrice(priceByKey, key, qty, harga);
      if (it.lineId) addPrice(priceByLineId, String(it.lineId), qty, harga);
      if (ks) addPrice(priceByKodeSatuan, ks, qty, harga);
      if (kode) addPrice(priceByKodeLegacy, kode, qty, harga);
      grnValue += qty * harga;
    }
  }

  return {
    receivedByKey,
    receivedByLineId,
    receivedByKodeSatuan,
    receivedByKodeLegacy,
    priceByKey,
    priceByLineId,
    priceByKodeSatuan,
    priceByKodeLegacy,
    grnValue,
  };
}

function subtractQty(map: Map<string, number>, key: string, qty: number) {
  if (!key || !map.has(key)) return;
  map.set(key, Math.max(0, (map.get(key) || 0) - qty));
}

/** Retur yang sudah keluar stok mengurangi qty dan nilai yang boleh ditagih. */
function applyPostedReturns(index: GrnReceivedIndex, returns: NonNullable<ThreeWayMatchOptions['postedReturns']>) {
  for (const doc of returns) {
    for (const it of doc.items || []) {
      const qty = parseFloat(String(it.qty)) || 0;
      if (!(qty > 0)) continue;
      const kode = String(it.kode || '');
      const productKey = invoiceLineProductKey(it);
      const key = lineMatchKey(kode, it.uomId, it.satuan, productKey);
      const ks = kodeSatuanKey(kode, it.satuan);
      subtractQty(index.receivedByKey, key, qty);
      if (it.lineId) subtractQty(index.receivedByLineId, String(it.lineId), qty);
      if (ks) subtractQty(index.receivedByKodeSatuan, ks, qty);
      if (kode) subtractQty(index.receivedByKodeLegacy, kode, qty);
      const harga = parseInt(String(it.harga || 0), 10) || resolveUnitPrice(it, index);
      index.grnValue = Math.max(0, index.grnValue - qty * harga);
    }
  }
}

function resolveUnitPrice(
  invLine: NonNullable<VendorInvoicePayload['items']>[number],
  index: GrnReceivedIndex,
): number {
  const kode = String(invLine.kode || '');
  const productKey = invoiceLineProductKey(invLine);
  const uomKey = lineMatchKey(kode, invLine.uomId, invLine.satuan, productKey);
  const pick = (bucket?: PriceBucket) => (bucket && bucket.qty > 0 ? Math.round(bucket.value / bucket.qty) : 0);
  if (invLine.lineId && index.priceByLineId.has(String(invLine.lineId))) {
    return pick(index.priceByLineId.get(String(invLine.lineId)));
  }
  if (index.priceByKey.has(uomKey)) return pick(index.priceByKey.get(uomKey));
  const ks = kodeSatuanKey(kode, invLine.satuan);
  if (ks && index.priceByKodeSatuan.has(ks)) return pick(index.priceByKodeSatuan.get(ks));
  if (index.priceByKodeLegacy.has(kode)) return pick(index.priceByKodeLegacy.get(kode));
  return 0;
}

export function resolveReceivedQtyForInvoiceLine(
  invLine: NonNullable<VendorInvoicePayload['items']>[number],
  index: GrnReceivedIndex,
): number {
  const kode = String(invLine.kode || '');
  const productKey = invoiceLineProductKey(invLine);
  const uomKey = lineMatchKey(kode, invLine.uomId, invLine.satuan, productKey);

  if (invLine.lineId && index.receivedByLineId.has(String(invLine.lineId))) {
    return index.receivedByLineId.get(String(invLine.lineId))!;
  }
  if (index.receivedByKey.has(uomKey)) {
    return index.receivedByKey.get(uomKey)!;
  }
  const ks = kodeSatuanKey(kode, invLine.satuan);
  if (ks && index.receivedByKodeSatuan.has(ks)) {
    return index.receivedByKodeSatuan.get(ks)!;
  }
  // Fallback kode saja bila GRN tidak punya UOM/satuan (invoice bisa punya satuan).
  if (index.receivedByKodeLegacy.has(kode)) {
    return index.receivedByKodeLegacy.get(kode)!;
  }
  return 0;
}

type ClaimBucket = { qty: number; invoices: Set<string> };

type AlreadyInvoicedIndex = {
  byKey: Map<string, ClaimBucket>;
  byLineId: Map<string, ClaimBucket>;
  byKodeSatuan: Map<string, ClaimBucket>;
  byKodeLegacy: Map<string, ClaimBucket>;
};

function addClaim(map: Map<string, ClaimBucket>, key: string, qty: number, noInvoice: string) {
  if (!key) return;
  const bucket = map.get(key) || { qty: 0, invoices: new Set<string>() };
  bucket.qty += qty;
  if (noInvoice) bucket.invoices.add(noInvoice);
  map.set(key, bucket);
}

/**
 * Qty per baris yang sudah ditagih invoice hutang LAIN (belum REJECTED) untuk GRN yang sama.
 * Sibling invoice datang dari submission vendor yang berbeda-beda (stokId/uomId masing-masing
 * vendor sendiri, bukan punya GRN) — pakai fallback bertingkat yang sama seperti
 * buildGrnReceivedIndex/resolveReceivedQtyForInvoiceLine: lineId dulu (paling reliable, sama
 * persis dengan lineId GRN — lihat hutang-line-reconcile.ts), baru kode+uom/stokId, lalu
 * kode+satuan, baru kode saja.
 */
function buildAlreadyInvoicedIndex(
  siblingInvoices: NonNullable<ThreeWayMatchOptions['siblingInvoices']>,
): AlreadyInvoicedIndex {
  const byKey: AlreadyInvoicedIndex['byKey'] = new Map();
  const byLineId: AlreadyInvoicedIndex['byLineId'] = new Map();
  const byKodeSatuan: AlreadyInvoicedIndex['byKodeSatuan'] = new Map();
  const byKodeLegacy: AlreadyInvoicedIndex['byKodeLegacy'] = new Map();

  for (const sibling of siblingInvoices) {
    const noInvoice = String(sibling.noInvoice || '').trim();
    for (const it of sibling.items || []) {
      const kode = String(it.kode || '');
      const productKey = invoiceLineProductKey(it);
      const qty = parseFloat(String(it.qty)) || 0;
      if (qty <= 0) continue;
      addClaim(byKey, lineMatchKey(kode, it.uomId, it.satuan, productKey), qty, noInvoice);
      if (it.lineId) addClaim(byLineId, String(it.lineId), qty, noInvoice);
      addClaim(byKodeSatuan, kodeSatuanKey(kode, it.satuan), qty, noInvoice);
      if (kode) addClaim(byKodeLegacy, kode, qty, noInvoice);
    }
  }

  return { byKey, byLineId, byKodeSatuan, byKodeLegacy };
}

function resolveAlreadyInvoicedForLine(
  invLine: NonNullable<VendorInvoicePayload['items']>[number],
  index: AlreadyInvoicedIndex,
): { qty: number; invoices: string[] } {
  const kode = String(invLine.kode || '');
  const productKey = invoiceLineProductKey(invLine);
  const uomKey = lineMatchKey(kode, invLine.uomId, invLine.satuan, productKey);

  let bucket: ClaimBucket | undefined;
  if (invLine.lineId) bucket = index.byLineId.get(String(invLine.lineId));
  if (!bucket) bucket = index.byKey.get(uomKey);
  if (!bucket) {
    const ks = kodeSatuanKey(kode, invLine.satuan);
    if (ks) bucket = index.byKodeSatuan.get(ks);
  }
  if (!bucket) bucket = index.byKodeLegacy.get(kode);

  if (!bucket) return { qty: 0, invoices: [] };
  return { qty: bucket.qty, invoices: Array.from(bucket.invoices) };
}

type PoLineIndex = {
  lineCount: number;
  byLineId: Map<string, PriceBucket>;
  byKey: Map<string, PriceBucket>;
  byKodeSatuan: Map<string, PriceBucket>;
  /** Baris PO tanpa satuan — boleh dicocokkan lewat kode saja. */
  byKodeNoUnit: Map<string, PriceBucket>;
  kodes: Set<string>;
};

function addPoBucket(map: Map<string, PriceBucket>, key: string, qty: number, harga: number) {
  if (!key) return;
  const bucket = map.get(key) || { qty: 0, value: 0 };
  bucket.qty += qty;
  bucket.value += qty * harga;
  map.set(key, bucket);
}

function buildPoLineIndex(lines: VendorInvoiceLine[]): PoLineIndex {
  const idx: PoLineIndex = {
    lineCount: 0,
    byLineId: new Map(),
    byKey: new Map(),
    byKodeSatuan: new Map(),
    byKodeNoUnit: new Map(),
    kodes: new Set(),
  };
  for (const it of lines) {
    const qty = parseFloat(String(it.qty)) || 0;
    if (!(qty > 0)) continue;
    idx.lineCount += 1;
    const kode = String(it.kode || '');
    const harga = parseInt(String(it.harga || 0), 10) || 0;
    if (it.lineId) addPoBucket(idx.byLineId, String(it.lineId), qty, harga);
    addPoBucket(idx.byKey, lineMatchKey(kode, it.uomId, it.satuan, invoiceLineProductKey(it)), qty, harga);
    addPoBucket(idx.byKodeSatuan, kodeSatuanKey(kode, it.satuan), qty, harga);
    if (!normalizeSatuan(it.satuan) && !it.uomId) addPoBucket(idx.byKodeNoUnit, normalizeKode(kode), qty, harga);
    if (kode) idx.kodes.add(normalizeKode(kode));
  }
  return idx;
}

/**
 * FOUND = baris PO dengan satuan yang sama. UNIT_DIFFERS = kode ada di PO dengan satuan lain
 * (tidak bisa dibandingkan; GRN tetap jadi batas). MISSING = barang tidak dipesan di PO.
 */
function resolvePoLine(
  invLine: VendorInvoiceLine,
  idx: PoLineIndex,
): { status: 'FOUND' | 'UNIT_DIFFERS' | 'MISSING'; qty: number; price: number } {
  const kode = String(invLine.kode || '');
  const pick = (b?: PriceBucket) => ({
    status: 'FOUND' as const,
    qty: b?.qty || 0,
    price: b && b.qty > 0 ? Math.round(b.value / b.qty) : 0,
  });
  if (invLine.lineId && idx.byLineId.has(String(invLine.lineId))) return pick(idx.byLineId.get(String(invLine.lineId)));
  const key = lineMatchKey(kode, invLine.uomId, invLine.satuan, invoiceLineProductKey(invLine));
  if (idx.byKey.has(key)) return pick(idx.byKey.get(key));
  const ks = kodeSatuanKey(kode, invLine.satuan);
  if (ks && idx.byKodeSatuan.has(ks)) return pick(idx.byKodeSatuan.get(ks));
  const nk = normalizeKode(kode);
  if (idx.byKodeNoUnit.has(nk)) return pick(idx.byKodeNoUnit.get(nk));
  if (nk && idx.kodes.has(nk)) return { status: 'UNIT_DIFFERS', qty: 0, price: 0 };
  return { status: 'MISSING', qty: 0, price: 0 };
}

/** Pure match logic — testable without MongoDB. */
export function matchInvoiceLinesAgainstGrn(
  grns: GrnRow[],
  payload: VendorInvoicePayload,
  opts: ThreeWayMatchOptions = {},
): ThreeWayMatchResult {
  const qtyTol = Number(opts.qtyTolerancePct ?? DEFAULT_QTY_TOLERANCE_PCT);
  const priceTol = Number(opts.priceTolerancePct ?? DEFAULT_PRICE_TOLERANCE_PCT);

  const index = buildGrnReceivedIndex(grns);
  applyPostedReturns(index, opts.postedReturns || []);
  const { grnValue } = index;
  const alreadyInvoiced = buildAlreadyInvoicedIndex(opts.siblingInvoices || []);
  const poIndex = buildPoLineIndex(opts.poLines || []);
  const poClaimed = buildAlreadyInvoicedIndex(opts.poSiblingInvoices || []);
  const poReturned = buildAlreadyInvoicedIndex(opts.poSiblingReturns || []);

  for (const invLine of payload.items || []) {
    const kode = String(invLine.kode || '');
    const invQty = parseFloat(String(invLine.qty)) || 0;
    const recQty = resolveReceivedQtyForInvoiceLine(invLine, index);
    const claimed = resolveAlreadyInvoicedForLine(invLine, alreadyInvoiced);
    const availableQty = Math.max(0, recQty - claimed.qty);
    const maxQty = availableQty * (1 + qtyTol / 100);
    const uomLabel = invLine.satuan || invLine.uomId || 'default';
    if (qtyGt(invQty, maxQty)) {
      if (qtyGt(claimed.qty, 0)) {
        return {
          ok: false,
          error: `3-way match qty: ${kode} (${uomLabel}) qty ${claimed.qty} sudah ditagih di invoice ${claimed.invoices.join(', ') || 'lain'} — sisa qty GRN yang bisa ditagih ${availableQty} (GRN qty ${recQty})`,
          code: 'GRN_ALREADY_INVOICED',
        };
      }
      return {
        ok: false,
        error: `3-way match qty: ${kode} (${uomLabel}) invoice ${invQty} > GRN posted ${recQty}`,
        code: 'QTY_MISMATCH',
      };
    }

    const invPrice = parseInt(String(invLine.harga || 0), 10);
    if (invPrice > 0) {
      const grnPrice = resolveUnitPrice(invLine, index);
      const maxPrice = grnPrice * (1 + priceTol / 100);
      if (grnPrice > 0 && invPrice > maxPrice + 1) {
        return {
          ok: false,
          error: `3-way match harga: ${kode} invoice Rp ${invPrice.toLocaleString('id-ID')} > harga GRN Rp ${grnPrice.toLocaleString('id-ID')} (+${priceTol}%)`,
          code: 'PRICE_MISMATCH',
        };
      }
    }

    if (poIndex.lineCount > 0 && invQty > 0) {
      const po = resolvePoLine(invLine, poIndex);
      if (po.status === 'MISSING') {
        return {
          ok: false,
          error: `3-way match PO: ${kode} (${uomLabel}) tidak ada di PO`,
          code: 'QTY_MISMATCH',
        };
      }
      if (po.status === 'FOUND') {
        const claimedPo = resolveAlreadyInvoicedForLine(invLine, poClaimed);
        const returnedPo = resolveAlreadyInvoicedForLine(invLine, poReturned);
        const netClaimed = Math.max(0, claimedPo.qty - returnedPo.qty);
        const poAvailable = Math.max(0, po.qty - netClaimed);
        if (qtyGt(invQty, poAvailable * (1 + qtyTol / 100))) {
          return {
            ok: false,
            error: qtyGt(netClaimed, 0)
              ? `3-way match PO: ${kode} (${uomLabel}) invoice ${invQty} > sisa qty PO ${poAvailable} (qty PO ${po.qty}, sudah ditagih ${netClaimed} di invoice ${claimedPo.invoices.join(', ') || 'lain'})`
              : `3-way match PO: ${kode} (${uomLabel}) invoice ${invQty} > qty PO ${po.qty}`,
            code: 'QTY_MISMATCH',
          };
        }
        if (invPrice > 0 && po.price > 0 && invPrice > po.price * (1 + priceTol / 100) + 1) {
          return {
            ok: false,
            error: `3-way match harga: ${kode} invoice Rp ${invPrice.toLocaleString('id-ID')} > harga PO/SO Rp ${po.price.toLocaleString('id-ID')} (+${priceTol}%)`,
            code: 'PRICE_MISMATCH',
          };
        }
      }
    }
  }

  const invSubTotal = invoiceComparableSubTotal(payload);
  const maxTotal = grnValue * (1 + priceTol / 100);
  if (invSubTotal > maxTotal + 1 && grnValue > 0) {
    return {
      ok: false,
      error: `3-way match harga: invoice Rp ${invSubTotal.toLocaleString('id-ID')} melebihi nilai GRN Rp ${grnValue.toLocaleString('id-ID')} (+${priceTol}% toleransi)`,
      code: 'PRICE_MISMATCH',
    };
  }

  return { ok: true, grnCount: grns.length, grnValue, invoiceTotal: invSubTotal };
}

export async function validateInvoiceAgainstGrn(
  db: Db,
  tenantId: string,
  payload: VendorInvoicePayload,
  opts: ThreeWayMatchOptions = {},
): Promise<ThreeWayMatchResult> {
  const noDO = payload.noDO;

  if (!noDO) {
    return { ok: false, error: '3-way match: noDO wajib pada invoice vendor' };
  }

  const grnFilter: Record<string, unknown> = {
    noDO,
    status: 'POSTED',
    ...tenantIdMatchFilter(tenantId),
  };
  if (payload.vendorTenantId) {
    grnFilter.vendorTenantId = payload.vendorTenantId;
  }

  const grns = await db.collection('goods_receipts').find(grnFilter).toArray() as GrnRow[];

  if (!grns.length) {
    return {
      ok: false,
      error: `3-way match gagal: belum ada GRN POSTED untuk DO ${noDO}. Post penerimaan barang dulu sebelum hutang dibuat.`,
      code: 'GRN_NOT_POSTED',
    };
  }

  const siblingFilter: Record<string, unknown> = {
    ...tenantIdMatchFilter(tenantId),
    noDO,
    referenceType: 'VENDOR_INVOICE',
    approvalStatus: { $ne: 'REJECTED' },
  };
  if (opts.excludeHutangId) siblingFilter.id = { $ne: opts.excludeHutangId };
  if (payload.vendorTenantId) siblingFilter.vendorTenantId = payload.vendorTenantId;
  const siblings = await db.collection('hutang')
    .find(siblingFilter)
    .project({ id: 1, vendorInvoiceId: 1, noInvoice: 1, items: 1 })
    .toArray();

  const liveHutangIds = new Set<string>(siblings.map((s) => String(s.id || '')).filter(Boolean));
  if (opts.excludeHutangId) liveHutangIds.add(String(opts.excludeHutangId));
  const liveInvoiceIds = new Set<string>(siblings.map((s) => String(s.vendorInvoiceId || '')).filter(Boolean));
  if (payload.invoiceId) liveInvoiceIds.add(String(payload.invoiceId));

  const returnFilter: Record<string, unknown> = {
    ...tenantIdMatchFilter(tenantId),
    status: 'POSTED',
    source: { $ne: 'grn-reject' },
    noDO,
  };
  if (payload.vendorTenantId) returnFilter.vendorTenantId = payload.vendorTenantId;
  const doReturns = await db.collection('vendor_returns')
    .find(returnFilter)
    .project({ hutangId: 1, vendorInvoiceId: 1, items: 1 })
    .toArray();
  // Retur yang terikat invoice hidup sudah dikreditkan lewat CN invoice itu.
  const postedReturns = doReturns.filter((r) => !isReturnTiedToInvoice(r, liveHutangIds, liveInvoiceIds));

  let poLines: VendorInvoiceLine[] | undefined;
  let poSiblingInvoices: { noInvoice?: string; items?: VendorInvoiceLine[] }[] | undefined;
  let poSiblingReturns: { items?: VendorInvoiceLine[] }[] | undefined;
  const noPO = String(payload.noPO || '').trim();
  if (noPO) {
    const po = await db.collection('customer_purchase_orders').findOne(
      { ...tenantIdMatchFilter(tenantId), noPO },
    );
    if (po) {
      const soSnap = resolveSoSnapshotForPo(po as JsonObject, {
        vendorTenantId: payload.vendorTenantId,
        salesOrderId: payload.salesOrderId,
        noSO: payload.noSO,
      } as unknown as HutangDoc);
      const soPrice = new Map<string, number>();
      for (const so of soSnap?.items || []) {
        const harga = parseInt(String(so.harga || 0), 10) || 0;
        const ks = kodeSatuanKey(so.kode, so.satuan);
        if (ks && harga > 0 && !soPrice.has(ks)) soPrice.set(ks, harga);
      }
      const items = Array.isArray(po.items) ? po.items as Array<Record<string, unknown>> : [];
      poLines = items.filter((it) => !it.cancelled).map((it) => {
        const kode = String(it.vendorKode || it.kode || '');
        const satuan = it.satuan ? String(it.satuan) : undefined;
        return {
          lineId: it.lineId ? String(it.lineId) : undefined,
          stokId: it.localStokId ? String(it.localStokId) : undefined,
          kode,
          uomId: it.uomId ? String(it.uomId) : undefined,
          satuan,
          qty: parseFloat(String(it.qty)) || 0,
          harga: soPrice.get(kodeSatuanKey(kode, satuan)) || 0,
        };
      });

      const poSiblingFilter: Record<string, unknown> = {
        ...tenantIdMatchFilter(tenantId),
        noPO,
        referenceType: 'VENDOR_INVOICE',
        approvalStatus: { $ne: 'REJECTED' },
      };
      const notSelf: Record<string, unknown>[] = [];
      if (opts.excludeHutangId) notSelf.push({ id: { $ne: opts.excludeHutangId } });
      if (payload.invoiceId) notSelf.push({ vendorInvoiceId: { $ne: payload.invoiceId } });
      if (notSelf.length) poSiblingFilter.$and = notSelf;
      const poSiblings = await db.collection('hutang')
        .find(poSiblingFilter)
        .project({ id: 1, noInvoice: 1, items: 1 })
        .toArray();
      poSiblingInvoices = poSiblings.map((s) => ({
        noInvoice: s.noInvoice as string | undefined,
        items: s.items as VendorInvoiceLine[] | undefined,
      }));
      const poSiblingIds = poSiblings.map((s) => String(s.id || '')).filter(Boolean);
      if (poSiblingIds.length) {
        const siblingReturns = await db.collection('vendor_returns')
          .find({
            ...tenantIdMatchFilter(tenantId),
            status: 'POSTED',
            source: { $ne: 'grn-reject' },
            hutangId: { $in: poSiblingIds },
          })
          .project({ items: 1 })
          .toArray();
        poSiblingReturns = siblingReturns.map(mapReturnDoc);
      }
    }
  }

  const tolerances = opts.qtyTolerancePct == null || opts.priceTolerancePct == null
    ? await getThreeWayTolerances(db, tenantId)
    : null;
  return matchInvoiceLinesAgainstGrn(grns, payload, {
    ...(tolerances || {}),
    ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
    siblingInvoices: siblings.map((s) => ({
      noInvoice: s.noInvoice as string | undefined,
      items: s.items as VendorInvoiceLine[] | undefined,
    })),
    postedReturns: postedReturns.map(mapReturnDoc),
    ...(poLines ? { poLines } : {}),
    ...(poSiblingInvoices ? { poSiblingInvoices } : {}),
    ...(poSiblingReturns ? { poSiblingReturns } : {}),
  });
}

function isReturnTiedToInvoice(
  r: Record<string, unknown>,
  liveHutangIds: Set<string>,
  liveInvoiceIds: Set<string>,
): boolean {
  const hid = String(r.hutangId || '');
  const vid = String(r.vendorInvoiceId || '');
  return (!!hid && liveHutangIds.has(hid)) || (!!vid && liveInvoiceIds.has(vid));
}

function mapReturnDoc(r: Record<string, unknown>): { items: VendorInvoiceLine[] } {
  return {
    items: ((r.items || []) as Array<Record<string, unknown>>).map((it) => {
      const lineId = it.grnLineId || it.invoiceLineId;
      return {
        lineId: lineId ? String(lineId) : undefined,
        stokId: it.localStokId ? String(it.localStokId) : undefined,
        kode: String(it.vendorKode || it.localKode || ''),
        uomId: it.uomId ? String(it.uomId) : undefined,
        satuan: it.satuan ? String(it.satuan) : undefined,
        qty: parseFloat(String(it.qty)) || 0,
        harga: parseInt(String(it.harga || 0), 10) || 0,
      };
    }),
  };
}
