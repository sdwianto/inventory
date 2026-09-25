/**
 * Acuan bahan per rencana produksi (Fase 1.1).
 * PO rencana (qty diterima, satuan dasar) adalah acuan; produk tanpa PO memakai MRP.
 * Hanya RL POSTED yang tertaut rencana dan PBL yang memutasi stok mengurangi sisa;
 * RL tanpa tautan masuk worklist "RL belum tertaut" (Fase 1.3), tidak ditebak ke rencana.
 * Satu baris per kode + satuan dasar, sama seperti kunci pengadaan.
 */

import type { ClientSession, Db } from 'mongodb';
import { withTenantFilter } from '@/lib/api/tenant-master';
import type { CpoLine } from '@/lib/api/cpo-status-sync';
import { listProductUomsByProductIds } from '@/lib/api/product-uom';
import { loadLiveProductMap } from '@/lib/api/resolve-live-catalog-product';
import { pickBaseUom } from '@/lib/uom/conversion';
import type { ProductUom } from '@/lib/uom/types';
import { convertQtySameFamily, normalizeRecipeSatuan } from '@/lib/food-production/recipe-uom';
import { RL_POSTED_STATUSES } from '@/lib/food-production/material-issue-reconcile';
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
  ceilProcurementQty,
  type MaterialRequirementLine,
} from '@/lib/food-production/material-requirement';
import { MATERIAL_ISSUES_COLLECTION } from '@/lib/food-production/material-issue';
import { isPoAppliedStatus } from '@/lib/food-production/production-plan';
import { getStokByWarehouseBatch } from '@/lib/api/stok-lokasi';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { roundQty } from '@/lib/stock-ledger/precision';
import { loadPlanBlockedQty, planBlockedPairKey } from '@/lib/stock-ledger/plan-available';

export const CUSTOMER_POS_COLLECTION = 'customer_purchase_orders';
const RELEASES_COLLECTION = 'inventory_releases';

type ScopeAuth = Parameters<typeof withTenantFilter>[0];

/** `NONE`: bahan hanya muncul dari RL/PBL/probe — tidak ada di PO maupun MRP rencana. */
export type PlanReferenceSource = 'PO' | 'MRP' | 'NONE';

export interface PlanReferencePoRef {
  poId: string;
  noPO: string;
  status: string;
  satuan?: string;
  qtyOrdered: number;
  qtyReceived: number;
}

export interface PlanReferenceRlRef {
  noRelease: string;
  qty: number;
}

export interface PlanReferenceLine {
  productId: string;
  /** Semua salinan katalog aktif dengan kode + satuan dasar yang sama. */
  productIds: string[];
  /** Id lama (nonaktif / tenant lain) yang dokumennya dipetakan ke baris ini. */
  aliasProductIds?: string[];
  productKode?: string;
  productNama?: string;
  /** Satuan dasar produk; semua qty di baris ini dalam satuan ini. */
  satuan?: string;
  sumber: PlanReferenceSource;
  acuanQty: number;
  qtyMrp: number;
  poQtyOrdered: number;
  poQtyReceived: number;
  poRefs: PlanReferencePoRef[];
  rlPosted: number;
  rlRefs: PlanReferenceRlRef[];
  /** RL DRAFT/PENDING_APPROVAL tertaut rencana, hanya bila `pendingRl`. Tidak mengurangi `sisa`. */
  rlPending?: number;
  /** PBL selesai yang memutasi stok (bukan mode referensi). */
  pblPosted: number;
  sisa: number;
  /** Stok gudang produk, hanya bila `withStock`. */
  qtyOnHand?: number;
  stockWarehouseKode?: string;
  warnings?: string[];
}

export interface PlanReference {
  productionPlanId: string;
  tenantId: string;
  mrpSource: 'MRP_DOC' | 'LIVE' | 'NONE';
  materialRequirementId?: string;
  lines: PlanReferenceLine[];
  summary: {
    lineCount: number;
    poLineCount: number;
    mrpLineCount: number;
    acuanTotal: number;
    rlPostedTotal: number;
    sisaTotal: number;
  };
}

export interface PlanReferencePlan {
  id: string;
  tenantId: string;
}

type QtySource = { qty: number; satuan?: string; uomId?: string };

/** Qty dalam satuan dokumen → satuan dasar produk. `converted: false` bila satuan tak dikenal. */
export function qtyToProductBase(
  input: QtySource,
  uoms: ProductUom[],
  fallbackBaseSatuan?: string,
): { qtyBase: number; baseSatuan?: string; converted: boolean } {
  const qty = Number(input.qty) || 0;
  const base = pickBaseUom(uoms);
  const baseSatuan = base?.satuan || String(fallbackBaseSatuan || '').trim().toUpperCase() || undefined;
  const sat = String(input.satuan || '').trim().toUpperCase();
  const uom = (input.uomId && uoms.find((u) => u.id === input.uomId))
    || (sat ? uoms.find((u) => u.satuan === sat) : undefined);
  if (uom) return { qtyBase: roundQty(qty * uom.factorToBase), baseSatuan, converted: true };
  if (!sat || !baseSatuan || sat === baseSatuan) return { qtyBase: roundQty(qty), baseSatuan, converted: true };
  const same = convertQtySameFamily(qty, sat, baseSatuan);
  if (same != null) return { qtyBase: roundQty(same), baseSatuan, converted: true };
  return { qtyBase: roundQty(qty), baseSatuan, converted: false };
}

type Acc = {
  productId: string;
  productIds: string[];
  aliasIds: string[];
  productKode?: string;
  productNama?: string;
  satuan?: string;
  qtyMrp: number;
  hasMrp: boolean;
  poQtyOrdered: number;
  poQtyReceived: number;
  poRefs: PlanReferencePoRef[];
  rlPosted: number;
  rlRefs: PlanReferenceRlRef[];
  rlPending: number;
  pblPosted: number;
  warnings: string[];
};

export const RL_PENDING_STATUSES = ['DRAFT', 'PENDING_APPROVAL'] as const;

type StockEntry = { qtyOnHand: number; stockWarehouseKode?: string };

/** Stok yang boleh dipakai rencana ini: stok gudang − tertahan QC − cadangan rencana lain. */
async function loadCanonicalStock(
  db: Db,
  tenantId: string,
  ids: string[],
  canonical: (id: string) => string,
  planId: string,
): Promise<Map<string, StockEntry>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, StockEntry>();
  if (!unique.length) return out;
  const [products, stockMap] = await Promise.all([
    db.collection('products')
      .find({ tenantId, id: { $in: unique } })
      .project({ id: 1, gudangKode: 1 })
      .toArray() as Promise<Array<{ id?: string; gudangKode?: string }>>,
    getStokByWarehouseBatch(db, tenantId, unique),
  ]);
  const gudangById = new Map(products.map((p) => [String(p.id), resolveProductGudangKode(p)]));
  const pairs = unique
    .filter((id) => gudangById.get(id))
    .map((id) => ({ productId: id, lokasiKode: String(gudangById.get(id)) }));
  const blockedByPair = await loadPlanBlockedQty(db, tenantId, pairs, planId);
  for (const id of unique) {
    const wh = gudangById.get(id);
    if (!wh) continue;
    const key = canonical(id);
    const gross = Number((stockMap.get(id) || {})[wh] || 0);
    const qty = Math.max(0, roundQty(gross - (blockedByPair.get(planBlockedPairKey(id, wh)) || 0)));
    const prev = out.get(key);
    out.set(key, {
      qtyOnHand: roundQty((prev?.qtyOnHand || 0) + qty),
      stockWarehouseKode: key === id ? wh : (prev?.stockWarehouseKode || wh),
    });
  }
  return out;
}

export type PlanReferenceMrpLine = Pick<
  MaterialRequirementLine,
  'productId' | 'productKode' | 'productNama' | 'satuan' | 'qtyGross'
>;
type MrpLineInput = PlanReferenceMrpLine;
type ReleaseItem = { stokId?: string; qtyBase?: number; qty?: number };

/**
 * Baca semua PO rencana yang sudah berlaku, MRP (dokumen terakhir, atau `fallbackMrpLines`),
 * RL POSTED dan PBL yang memutasi stok. Salinan katalog dengan kode + satuan dasar sama digabung.
 * `withStock`: isi stok gudang produk (gudang produk, termasuk salinan katalog lama).
 * `pendingRl`: isi `rlPending` dari RL tertaut yang belum diposting (kecuali `excludeReleaseId`).
 * `session`: dokumen transaksi (PO, MRP, RL, PBL) dibaca dalam snapshot transaksi pemanggil.
 */
export async function loadPlanReference(
  db: Db,
  scopeAuth: ScopeAuth,
  plan: PlanReferencePlan,
  opts: {
    fallbackMrpLines?: MrpLineInput[];
    withStock?: boolean;
    pendingRl?: { excludeReleaseId?: string };
    session?: ClientSession;
    /** Produk RL yang akan dicek; dipetakan ke baris acuan dengan kode + satuan dasar yang sama. */
    probeProductIds?: string[];
  } = {},
): Promise<PlanReference> {
  const planId = String(plan.id || '').trim();
  const tenantId = String(plan.tenantId || '').trim();
  const excludeReleaseId = String(opts.pendingRl?.excludeReleaseId || '').trim();
  const s = opts.session ? { session: opts.session } : {};

  // Sekuensial bila dalam transaksi: satu session tidak boleh menjalankan operasi paralel.
  const run = async <T>(tasks: Array<() => Promise<T>>): Promise<T[]> => {
    if (!opts.session) return Promise.all(tasks.map((t) => t()));
    const out: T[] = [];
    for (const t of tasks) out.push(await t());
    return out;
  };

  type PoRow = { id?: string; noPO?: string; status?: string; items?: CpoLine[] };
  type MrpDoc = { id?: string; lines?: MrpLineInput[] } | null;
  type RlRow = { noRelease?: string; items?: ReleaseItem[] };
  type IssueRow = { lines?: Array<{ productId?: string; qtyIssued?: number }> };
  const [pos, mrpDoc, releases, postedIssues, pendingReleases] = await run<unknown>([
    () => db.collection(CUSTOMER_POS_COLLECTION)
      .find(withTenantFilter(scopeAuth, { productionPlanId: planId, status: { $nin: ['CANCELLED'] } }), s)
      .project({ id: 1, noPO: 1, status: 1, items: 1 })
      .toArray(),
    () => db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { productionPlanId: planId, status: { $nin: ['CANCELLED'] } }),
      { sort: { createdAt: -1 }, projection: { id: 1, lines: 1 }, ...s },
    ),
    () => db.collection(RELEASES_COLLECTION)
      .find(withTenantFilter(scopeAuth, { productionPlanId: planId, status: { $in: [...RL_POSTED_STATUSES] } }), s)
      .project({ noRelease: 1, items: 1 })
      .toArray(),
    () => db.collection(MATERIAL_ISSUES_COLLECTION)
      .find(withTenantFilter(scopeAuth, {
        productionPlanId: planId,
        status: 'COMPLETED',
        stockMode: { $ne: 'REFERENCE' },
      }), s)
      .project({ lines: 1 })
      .toArray(),
    () => (opts.pendingRl
      ? db.collection(RELEASES_COLLECTION)
        .find(withTenantFilter(scopeAuth, {
          productionPlanId: planId,
          status: { $in: [...RL_PENDING_STATUSES] },
          ...(excludeReleaseId ? { id: { $ne: excludeReleaseId } } : {}),
        }), s)
        .project({ items: 1 })
        .toArray()
      : Promise.resolve([])),
  ]) as [PoRow[], MrpDoc, RlRow[], IssueRow[], RlRow[]];

  const appliedPos = pos.filter((po) => isPoAppliedStatus(po.status));
  const mrpLines = mrpDoc?.lines?.length ? mrpDoc.lines : (opts.fallbackMrpLines || []);
  const mrpSource: PlanReference['mrpSource'] = mrpDoc?.lines?.length
    ? 'MRP_DOC'
    : (opts.fallbackMrpLines?.length ? 'LIVE' : 'NONE');

  const rawIds = new Set<string>();
  for (const po of appliedPos) {
    for (const it of po.items || []) if (it.localStokId) rawIds.add(String(it.localStokId));
  }
  for (const l of mrpLines) if (l.productId) rawIds.add(String(l.productId));
  for (const rl of releases) for (const it of rl.items || []) if (it.stokId) rawIds.add(String(it.stokId));
  for (const rl of pendingReleases) for (const it of rl.items || []) if (it.stokId) rawIds.add(String(it.stokId));
  for (const iss of postedIssues) for (const l of iss.lines || []) if (l.productId) rawIds.add(String(l.productId));
  const probeIds = [...new Set((opts.probeProductIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  for (const id of probeIds) rawIds.add(id);
  const liveMap = rawIds.size ? await loadLiveProductMap(db, tenantId, [...rawIds]) : new Map();
  const canonical = (id: string) => String(liveMap.get(id)?.id || id);
  const canonicalIds = [...new Set([...rawIds].map(canonical))];
  // Salinan vendor tergabung: satuan dasar sama dengan item kanonik, tetapi kemasan (SAK/DUS) bisa beda per vendor.
  const mergedRawIds = rawIds.size
    ? (await db.collection('products')
      .find({ tenantId, id: { $in: [...rawIds] }, mergedInto: { $type: 'string' } }, s)
      .project({ id: 1 })
      .toArray()).map((p) => String(p.id))
    : [];
  const mergedRaw = new Set(mergedRawIds);
  const uomIds = [...new Set([...canonicalIds, ...mergedRawIds])];
  const uomsByProduct = uomIds.length
    ? await listProductUomsByProductIds(db, tenantId, uomIds)
    : new Map<string, ProductUom[]>();
  const uomOwner = (rawId: string, canonId: string) => (mergedRaw.has(rawId) ? rawId : canonId);

  const baseSatuanOf = (canonId: string, rawId: string): string | undefined => {
    const base = pickBaseUom(uomsByProduct.get(canonId) || []);
    return base?.satuan || String(liveMap.get(rawId)?.satuan || '').trim().toUpperCase() || undefined;
  };

  const acc = new Map<string, Acc>();
  const touch = (rawId: string, meta: { kode?: string; nama?: string } = {}): { row: Acc; canonId: string } => {
    const canonId = canonical(rawId);
    const live = liveMap.get(rawId);
    const satuan = baseSatuanOf(canonId, rawId);
    const kode = String(live?.kode || meta.kode || '').trim().toUpperCase();
    const key = kode ? `kode:${kode}::${normalizeRecipeSatuan(satuan) || ''}` : `id:${canonId}`;
    let row = acc.get(key);
    if (!row) {
      row = {
        productId: canonId,
        productIds: [],
        aliasIds: [],
        productKode: live?.kode || meta.kode,
        productNama: live?.nama || meta.nama,
        satuan,
        qtyMrp: 0,
        hasMrp: false,
        poQtyOrdered: 0,
        poQtyReceived: 0,
        poRefs: [],
        rlPosted: 0,
        rlRefs: [],
        rlPending: 0,
        pblPosted: 0,
        warnings: [],
      };
      acc.set(key, row);
    }
    if (!row.productIds.includes(canonId)) row.productIds.push(canonId);
    if (rawId !== canonId && !row.aliasIds.includes(rawId)) row.aliasIds.push(rawId);
    return { row, canonId };
  };
  const toBase = (row: Acc, uomProductId: string, src: QtySource, label: string): number => {
    const res = qtyToProductBase(src, uomsByProduct.get(uomProductId) || [], row.satuan);
    if (!res.converted) {
      row.warnings.push(`${label}: satuan ${src.satuan} tidak terkonversi ke ${row.satuan || 'satuan dasar'}`);
    }
    return res.qtyBase;
  };
  const addRl = (rawId: string, qty: number, noRelease: string) => {
    if (!(qty > 0)) return;
    const { row } = touch(rawId);
    row.rlPosted = roundQty(row.rlPosted + qty);
    row.rlRefs.push({ noRelease, qty: roundQty(qty) });
  };

  for (const po of appliedPos) {
    for (const it of po.items || []) {
      if (!it.localStokId || it.cancelled) continue;
      const ordered = Math.max(0, (parseFloat(String(it.qty)) || 0) - (Number(it.qtyShortClosed) || 0));
      const received = Number(it.qtyReceived) || 0;
      if (!(ordered > 0) && !(received > 0)) continue;
      const rawId = String(it.localStokId);
      const { row, canonId } = touch(rawId, { kode: it.kode || it.vendorKode });
      const src = { satuan: it.satuan, uomId: it.uomId };
      const label = `PO ${po.noPO || po.id}`;
      const owner = uomOwner(rawId, canonId);
      row.poQtyOrdered = roundQty(row.poQtyOrdered + toBase(row, owner, { ...src, qty: ordered }, label));
      row.poQtyReceived = roundQty(row.poQtyReceived + toBase(row, owner, { ...src, qty: received }, label));
      row.poRefs.push({
        poId: String(po.id || ''),
        noPO: String(po.noPO || ''),
        status: String(po.status || ''),
        satuan: it.satuan,
        qtyOrdered: roundQty(ordered),
        qtyReceived: roundQty(received),
      });
    }
  }

  for (const l of mrpLines) {
    if (!l.productId) continue;
    const { row, canonId } = touch(String(l.productId), { kode: l.productKode, nama: l.productNama });
    row.hasMrp = true;
    row.qtyMrp = roundQty(row.qtyMrp + toBase(row, canonId, { qty: Number(l.qtyGross) || 0, satuan: l.satuan }, 'MRP'));
    if (!row.productNama && l.productNama) row.productNama = l.productNama;
  }

  for (const rl of releases) {
    for (const it of rl.items || []) {
      if (!it.stokId) continue;
      addRl(String(it.stokId), Number(it.qtyBase ?? it.qty) || 0, String(rl.noRelease || ''));
    }
  }

  const pendingRows = new Set<Acc>();
  for (const rl of pendingReleases) {
    for (const it of rl.items || []) {
      if (!it.stokId) continue;
      const qty = Number(it.qtyBase ?? it.qty) || 0;
      if (!(qty > 0)) continue;
      const { row } = touch(String(it.stokId));
      row.rlPending = roundQty(row.rlPending + qty);
      pendingRows.add(row);
    }
  }

  for (const iss of postedIssues) {
    for (const l of iss.lines || []) {
      if (!l.productId) continue;
      const qty = Number(l.qtyIssued) || 0;
      if (!(qty > 0)) continue;
      const { row } = touch(String(l.productId));
      row.pblPosted = roundQty(row.pblPosted + qty);
    }
  }

  for (const id of probeIds) touch(id);

  const stockById = opts.withStock
    ? await loadCanonicalStock(db, tenantId, [...rawIds, ...canonicalIds], canonical, planId)
    : new Map<string, StockEntry>();

  const lines: PlanReferenceLine[] = [...acc.values()]
    .filter((r) => r.poRefs.length || r.hasMrp || r.rlPosted > 0 || r.pblPosted > 0 || pendingRows.has(r))
    .map((r) => {
      const sumber: PlanReferenceSource = r.poRefs.length ? 'PO' : r.hasMrp ? 'MRP' : 'NONE';
      const acuanQty = sumber === 'PO' ? r.poQtyReceived : sumber === 'MRP' ? ceilProcurementQty(r.qtyMrp, r.satuan) : 0;
      const sisa = Math.max(0, roundQty(acuanQty - r.rlPosted - r.pblPosted));
      let stock: StockEntry | undefined;
      if (opts.withStock) {
        stock = { qtyOnHand: 0, stockWarehouseKode: stockById.get(r.productId)?.stockWarehouseKode };
        for (const id of r.productIds) {
          const s = stockById.get(id);
          if (!s) continue;
          stock.qtyOnHand = roundQty(stock.qtyOnHand + s.qtyOnHand);
          stock.stockWarehouseKode ||= s.stockWarehouseKode;
        }
      }
      return {
        productId: r.productId,
        productIds: r.productIds,
        ...(r.aliasIds.length ? { aliasProductIds: r.aliasIds } : {}),
        productKode: r.productKode,
        productNama: r.productNama,
        satuan: r.satuan,
        sumber,
        acuanQty,
        qtyMrp: r.qtyMrp,
        poQtyOrdered: r.poQtyOrdered,
        poQtyReceived: r.poQtyReceived,
        poRefs: r.poRefs,
        rlPosted: r.rlPosted,
        rlRefs: r.rlRefs,
        ...(opts.pendingRl ? { rlPending: r.rlPending } : {}),
        pblPosted: r.pblPosted,
        sisa,
        ...(stock ? { qtyOnHand: stock.qtyOnHand } : {}),
        ...(stock?.stockWarehouseKode ? { stockWarehouseKode: stock.stockWarehouseKode } : {}),
        ...(r.warnings.length ? { warnings: [...new Set(r.warnings)] } : {}),
      };
    })
    .sort((a, b) => String(a.productNama || a.productKode || a.productId)
      .localeCompare(String(b.productNama || b.productKode || b.productId), 'id'));

  return {
    productionPlanId: planId,
    tenantId,
    mrpSource,
    ...(mrpDoc?.id && mrpSource === 'MRP_DOC' ? { materialRequirementId: String(mrpDoc.id) } : {}),
    lines,
    summary: {
      lineCount: lines.length,
      poLineCount: lines.filter((l) => l.sumber === 'PO').length,
      mrpLineCount: lines.filter((l) => l.sumber === 'MRP').length,
      acuanTotal: roundQty(lines.reduce((s, l) => s + l.acuanQty, 0)),
      rlPostedTotal: roundQty(lines.reduce((s, l) => s + l.rlPosted, 0)),
      sisaTotal: roundQty(lines.reduce((s, l) => s + l.sisa, 0)),
    },
  };
}

export type PlanReadinessLine = MaterialRequirementLine & {
  productIds: string[];
  stockWarehouseKode?: string;
  acuanQty: number;
  rlPosted: number;
  sisa: number;
};

/**
 * Kekurangan per baris acuan.
 * PO: dipesan − diterima (menunggu kiriman). MRP: kebutuhan − sudah keluar − stok gudang.
 * Konsumsi tidak menimpa baris PO.
 */
export function planReferenceReadiness(
  reference: PlanReference,
): { lines: PlanReadinessLine[]; summary: { shortageCount: number; qtyNetTotal: number } } {
  const lines: PlanReadinessLine[] = reference.lines.map((l) => {
    const qtyOnHand = roundQty(l.qtyOnHand ?? 0);
    const consumed = roundQty(l.rlPosted + l.pblPosted);
    const qtyNet = l.sumber === 'PO'
      ? Math.max(0, roundQty(l.poQtyOrdered - l.poQtyReceived))
      : ceilProcurementQty(Math.max(0, roundQty(l.qtyMrp - consumed - qtyOnHand)), l.satuan);
    return {
      productId: l.productId,
      productIds: l.productIds,
      productKode: l.productKode,
      productNama: l.productNama,
      satuan: l.satuan,
      qtyGross: l.sumber === 'PO' ? l.poQtyOrdered : l.qtyMrp,
      qtyOnHand,
      qtyNet,
      shortage: qtyNet > 0,
      sources: [],
      ...(l.sumber === 'PO'
        ? { sourceOfTruth: 'PO' as const, poQtyOrdered: l.poQtyOrdered, poQtyReceived: l.poQtyReceived }
        : {}),
      ...(l.stockWarehouseKode ? { stockWarehouseKode: l.stockWarehouseKode } : {}),
      acuanQty: l.acuanQty,
      rlPosted: l.rlPosted,
      sisa: l.sisa,
    };
  });
  return {
    lines,
    summary: {
      shortageCount: lines.filter((l) => l.shortage).length,
      qtyNetTotal: roundQty(lines.reduce((s, l) => s + l.qtyNet, 0)),
    },
  };
}
