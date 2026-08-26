// Panduan Release — lot SOH + asal PO/RPN + tgl terima + status invoice
// + residual SOH dari stok_lokasi. Display SOH capped by saldo aktual (stok_lokasi).

import type { NextResponse } from 'next/server';
import { ok, err } from '@/lib/api/db';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import {
  isValidWarehouseKode,
  normalizeWarehouseKode,
  warehouseLabel,
  WAREHOUSE_CODES,
} from '@/lib/api/warehouses';
import { INGREDIENT_LOTS_COLLECTION, type IngredientLotDoc } from '@/lib/food-production/ingredient-lot';
import type { HandlerContext } from '@/types/api/handler';

type InvoiceStatusLabel = 'SUDAH' | 'BELUM' | 'N/A';

type PanduanRow = {
  lotId: string | null;
  lotNo: string | null;
  productId: string;
  productKode: string;
  productNama: string;
  satuan: string;
  soh: number;
  warehouseKode: string;
  warehouseNama: string;
  asal: string;
  noPO: string | null;
  noRpn: string | null;
  noGRN: string | null;
  purchaseRequirementNo: string | null;
  tanggalTerima: string | null;
  invoiceStatus: InvoiceStatusLabel;
  noInvoice: string | null;
  lotStatus: string | null;
  tracked: boolean;
};

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function deriveInvoiceStatus(grn: {
  noInvoice?: unknown;
  invoiceSyncStatus?: unknown;
} | null): InvoiceStatusLabel {
  if (!grn) return 'BELUM';
  const sync = str(grn.invoiceSyncStatus).toUpperCase();
  if (sync === 'SKIPPED') return 'N/A';
  if (str(grn.noInvoice) || sync === 'DONE') return 'SUDAH';
  return 'BELUM';
}

function buildAsal(noPO: string, noRpn: string): string {
  if (noPO && noRpn) return `PO ${noPO} dari RPN ${noRpn}`;
  if (noPO) return `PO ${noPO}`;
  if (noRpn) return `RPN ${noRpn}`;
  return '—';
}

function toIsoDate(v: unknown): string {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = str(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

function productWhKey(productId: string, warehouseKode: string): string {
  return `${productId}::${warehouseKode}`;
}

export async function handlePanduanRelease({
  db,
  route,
  method,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (route !== '/stok/panduan-release' || method !== 'GET') return null;

  const { denied, tenantId: tid } = resolveOperationalScope(auth, { url, request });
  if (denied) return denied;
  if (!tid) return err('Scope tidak valid', 400);

  const warehouseRaw = url.searchParams.get('warehouseKode') || '';
  let warehouseKode = '';
  if (warehouseRaw && warehouseRaw.toUpperCase() !== 'ALL') {
    warehouseKode = normalizeWarehouseKode(warehouseRaw);
    if (!isValidWarehouseKode(warehouseKode)) {
      return err('warehouseKode tidak valid', 400);
    }
  }

  const lotFilter: Record<string, unknown> = {
    tenantId: tid,
    qtyRemaining: { $gt: 0 },
    status: { $in: ['ACTIVE', 'EXPIRED'] },
  };
  if (warehouseKode) lotFilter.warehouseKode = warehouseKode;

  const lots = await db.collection(INGREDIENT_LOTS_COLLECTION)
    .find(lotFilter)
    .project({
      id: 1,
      lotNo: 1,
      grnId: 1,
      noGRN: 1,
      productId: 1,
      productKode: 1,
      productNama: 1,
      satuan: 1,
      warehouseKode: 1,
      receivedAt: 1,
      expiryDate: 1,
      qtyRemaining: 1,
      status: 1,
    })
    .sort({ productNama: 1, receivedAt: 1 })
    .limit(2000)
    .toArray() as unknown as IngredientLotDoc[];

  const grnIds = [...new Set(lots.map((l) => str(l.grnId)).filter(Boolean))];
  const grns = grnIds.length
    ? await db.collection('goods_receipts')
      .find({ tenantId: tid, id: { $in: grnIds } })
      .project({
        id: 1,
        noPO: 1,
        noGRN: 1,
        postedAt: 1,
        tanggal: 1,
        noInvoice: 1,
        invoiceSyncStatus: 1,
      })
      .toArray()
    : [];
  const grnById = new Map(grns.map((g) => [str(g.id), g]));

  const noPOs = [...new Set(grns.map((g) => str(g.noPO)).filter(Boolean))];
  const pos = noPOs.length
    ? await db.collection('customer_purchase_orders')
      .find({ tenantId: tid, noPO: { $in: noPOs } })
      .project({
        noPO: 1,
        productionPlanId: 1,
        purchaseRequirementNo: 1,
      })
      .toArray()
    : [];
  const poByNo = new Map(pos.map((p) => [str(p.noPO), p]));

  const planIds = [...new Set(pos.map((p) => str(p.productionPlanId)).filter(Boolean))];
  const plans = planIds.length
    ? await db.collection('production_plans')
      .find({ tenantId: tid, id: { $in: planIds } })
      .project({ id: 1, noDokumen: 1 })
      .toArray()
    : [];
  const planById = new Map(plans.map((p) => [str(p.id), p]));

  const lotProductIds = [...new Set(lots.map((l) => str(l.productId)).filter(Boolean))];
  const stokFilter: Record<string, unknown> = {
    tenantId: tid,
    lokasiKode: warehouseKode
      ? warehouseKode
      : { $in: [...WAREHOUSE_CODES] },
  };
  // Saldo aktual (termasuk 0) untuk produk ber-lot + baris qty>0 untuk sisa tanpa lot.
  if (lotProductIds.length) {
    stokFilter.$or = [
      { qty: { $gt: 0 } },
      { stokId: { $in: lotProductIds } },
    ];
  } else {
    stokFilter.qty = { $gt: 0 };
  }

  const stokRows = await db.collection('stok_lokasi')
    .find(stokFilter)
    .project({ stokId: 1, lokasiKode: 1, qty: 1 })
    .limit(5000)
    .toArray();

  const stockByProductWh = new Map<string, number>();
  for (const s of stokRows) {
    const productId = str(s.stokId);
    const wh = normalizeWarehouseKode(str(s.lokasiKode));
    if (!productId || !isValidWarehouseKode(wh)) continue;
    stockByProductWh.set(productWhKey(productId, wh), Number(s.qty) || 0);
  }

  const productIdsNeeded = new Set<string>(lotProductIds);
  for (const s of stokRows) {
    const pid = str(s.stokId);
    if (pid) productIdsNeeded.add(pid);
  }

  const products = productIdsNeeded.size
    ? await db.collection('products')
      .find({ tenantId: tid, id: { $in: [...productIdsNeeded] } })
      .project({ id: 1, kode: 1, nama: 1, satuan: 1 })
      .toArray()
    : [];
  const productById = new Map(products.map((p) => [str(p.id), p]));

  type LotEnrich = {
    lot: IngredientLotDoc;
    productKode: string;
    productNama: string;
    satuan: string;
    wh: string;
    grn: (typeof grns)[number] | null;
    noPO: string;
    noRpn: string;
    purchaseRequirementNo: string;
  };

  const lotsByKey = new Map<string, LotEnrich[]>();
  for (const lot of lots) {
    const wh = normalizeWarehouseKode(lot.warehouseKode);
    const productId = str(lot.productId);
    if (!productId || !isValidWarehouseKode(wh)) continue;
    const product = productById.get(productId);
    const grn = grnById.get(str(lot.grnId)) || null;
    const noPO = str(grn?.noPO);
    const po = noPO ? poByNo.get(noPO) : undefined;
    const planId = str(po?.productionPlanId);
    const plan = planId ? planById.get(planId) : undefined;
    const key = productWhKey(productId, wh);
    const list = lotsByKey.get(key) || [];
    list.push({
      lot,
      productKode: str(lot.productKode) || str(product?.kode),
      productNama: str(lot.productNama) || str(product?.nama),
      satuan: str(lot.satuan) || str(product?.satuan),
      wh,
      grn,
      noPO,
      noRpn: str(plan?.noDokumen),
      purchaseRequirementNo: str(po?.purchaseRequirementNo),
    });
    lotsByKey.set(key, list);
  }

  const rows: PanduanRow[] = [];
  const allocatedByProductWh = new Map<string, number>();

  // Cap display SOH by stok_lokasi so post-release Panduan matches Saldo
  // even if older releases did not consume ingredient_lots.
  for (const [key, group] of lotsByKey) {
    const stockQty = stockByProductWh.get(key) || 0;
    if (stockQty <= 0) {
      allocatedByProductWh.set(key, 0);
      continue;
    }
    group.sort((a, b) => {
      const byRecv = str(a.lot.receivedAt).localeCompare(str(b.lot.receivedAt));
      if (byRecv !== 0) return byRecv;
      return str(a.lot.expiryDate).localeCompare(str(b.lot.expiryDate));
    });
    let remaining = stockQty;
    let allocated = 0;
    for (const item of group) {
      if (remaining <= 0) break;
      const lotRem = Number(item.lot.qtyRemaining) || 0;
      if (lotRem <= 0) continue;
      const soh = Math.min(lotRem, remaining);
      if (soh <= 0) continue;
      remaining = Math.round((remaining - soh) * 1000) / 1000;
      allocated = Math.round((allocated + soh) * 1000) / 1000;
      const { lot, grn, noPO, noRpn } = item;
      rows.push({
        lotId: lot.id,
        lotNo: lot.lotNo || null,
        productId: str(lot.productId),
        productKode: item.productKode,
        productNama: item.productNama,
        satuan: item.satuan,
        soh,
        warehouseKode: item.wh,
        warehouseNama: warehouseLabel(item.wh),
        asal: buildAsal(noPO, noRpn),
        noPO: noPO || null,
        noRpn: noRpn || null,
        noGRN: str(lot.noGRN) || str(grn?.noGRN) || null,
        purchaseRequirementNo: item.purchaseRequirementNo || null,
        tanggalTerima: toIsoDate(lot.receivedAt)
          || toIsoDate(grn?.postedAt)
          || toIsoDate(grn?.tanggal)
          || null,
        invoiceStatus: deriveInvoiceStatus(grn),
        noInvoice: str(grn?.noInvoice) || null,
        lotStatus: lot.status || null,
        tracked: true,
      });
    }
    allocatedByProductWh.set(key, allocated);
  }

  for (const [key, stockQty] of stockByProductWh) {
    if (stockQty <= 0) continue;
    const lotAllocated = allocatedByProductWh.get(key) || 0;
    const residual = Math.round((stockQty - lotAllocated) * 1000) / 1000;
    if (residual <= 0) continue;
    const [productId, wh] = key.split('::');
    if (!productId || !wh) continue;
    const product = productById.get(productId);
    rows.push({
      lotId: null,
      lotNo: null,
      productId,
      productKode: str(product?.kode),
      productNama: str(product?.nama),
      satuan: str(product?.satuan),
      soh: residual,
      warehouseKode: wh,
      warehouseNama: warehouseLabel(wh),
      asal: 'Tidak terlacak (tanpa lot)',
      noPO: null,
      noRpn: null,
      noGRN: null,
      purchaseRequirementNo: null,
      tanggalTerima: null,
      invoiceStatus: 'N/A',
      noInvoice: null,
      lotStatus: null,
      tracked: false,
    });
  }

  rows.sort((a, b) => {
    const byNama = a.productNama.localeCompare(b.productNama, 'id');
    if (byNama !== 0) return byNama;
    const byWh = a.warehouseKode.localeCompare(b.warehouseKode);
    if (byWh !== 0) return byWh;
    if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
    return str(a.tanggalTerima).localeCompare(str(b.tanggalTerima));
  });

  return ok({
    warehouseKode: warehouseKode || null,
    warehouseNama: warehouseKode ? warehouseLabel(warehouseKode) : null,
    rows,
  });
}
