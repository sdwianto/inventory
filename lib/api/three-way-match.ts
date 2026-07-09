import type { Db } from 'mongodb';
// 3-way match: Invoice vendor vs GRN POSTED — per kode + UOM (P1.3a).

import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import type {
  ThreeWayMatchOptions,
  ThreeWayMatchResult,
  VendorInvoicePayload,
} from '@/types/integration';

const DEFAULT_QTY_TOLERANCE_PCT = 0;
const DEFAULT_PRICE_TOLERANCE_PCT = 2;

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

type GrnReceivedIndex = {
  receivedByKey: Map<string, number>;
  receivedByLineId: Map<string, number>;
  receivedByKodeSatuan: Map<string, number>;
  receivedByKodeLegacy: Map<string, number>;
  grnValue: number;
};

function buildGrnReceivedIndex(grns: GrnRow[]): GrnReceivedIndex {
  const receivedByKey = new Map<string, number>();
  const receivedByLineId = new Map<string, number>();
  const receivedByKodeSatuan = new Map<string, number>();
  const receivedByKodeLegacy = new Map<string, number>();
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
      grnValue += qty * harga;
    }
  }

  return {
    receivedByKey,
    receivedByLineId,
    receivedByKodeSatuan,
    receivedByKodeLegacy,
    grnValue,
  };
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

/** Pure match logic — testable without MongoDB. */
export function matchInvoiceLinesAgainstGrn(
  grns: GrnRow[],
  payload: VendorInvoicePayload,
  opts: ThreeWayMatchOptions = {},
): ThreeWayMatchResult {
  const qtyTol = Number(opts.qtyTolerancePct ?? DEFAULT_QTY_TOLERANCE_PCT);
  const priceTol = Number(opts.priceTolerancePct ?? DEFAULT_PRICE_TOLERANCE_PCT);

  const index = buildGrnReceivedIndex(grns);
  const { grnValue } = index;

  for (const invLine of payload.items || []) {
    const kode = String(invLine.kode || '');
    const invQty = parseFloat(String(invLine.qty)) || 0;
    const recQty = resolveReceivedQtyForInvoiceLine(invLine, index);
    const maxQty = recQty * (1 + qtyTol / 100);
    if (invQty > maxQty + 0.0001) {
      const uomLabel = invLine.satuan || invLine.uomId || 'default';
      return {
        ok: false,
        error: `3-way match qty: ${kode} (${uomLabel}) invoice ${invQty} > GRN posted ${recQty}`,
        code: 'QTY_MISMATCH',
      };
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

  return matchInvoiceLinesAgainstGrn(grns, payload, opts);
}
