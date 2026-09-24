/**
 * Isi RL dari acuan rencana (Fase 1.2).
 * Per produk: min(sisa − RL belum diposting, stok tersedia di gudang asal), dalam satuan dasar.
 * Stok tersedia sama dengan validasi RL: lokasi dibatasi saldo kartu, dikurangi batch HOLD.
 */

import type { Db } from 'mongodb';
import { withTenantFilter } from '@/lib/api/tenant-master';
import { listProductUomsByProductIds } from '@/lib/api/product-uom';
import { getStokByWarehouseBatch } from '@/lib/api/stok-lokasi';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { isFoodSafetyHoldEnforced } from '@/lib/api/feature-flags';
import { availableQtyAgainstLedger, ledgerSaldoForProducts } from '@/lib/stock-ledger';
import { roundQty } from '@/lib/stock-ledger/precision';
import { pickBaseUom } from '@/lib/uom/conversion';
import {
  PRODUCTION_BATCHES_COLLECTION,
  effectiveFoodSafetyStatus,
  effectiveQtyRemaining,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import {
  loadPlanReference,
  type PlanReference,
  type PlanReferenceMrpLine,
  type PlanReferencePlan,
  type PlanReferenceSource,
} from '@/lib/food-production/plan-reference';

type ScopeAuth = Parameters<typeof withTenantFilter>[0];

export interface ReleasePrefillLine {
  stokId: string;
  kode?: string;
  nama?: string;
  /** UOM dasar; qty baris ini dalam satuan dasar. */
  uomId: string;
  satuan?: string;
  qty: number;
  qtyBase: number;
  /** Qty dalam satuan PO, hanya informasi. */
  display?: { qty: number; satuan: string };
  sumber: PlanReferenceSource;
  acuanQty: number;
  rlPosted: number;
  rlPending: number;
  sisa: number;
  stokAvail: number;
  cappedByStock: boolean;
  warnings?: string[];
}

export type ReleasePrefillSkipReason = 'BELUM_DITERIMA' | 'SELESAI' | 'MENUNGGU_RL' | 'GUDANG_LAIN' | 'STOK_KOSONG';

export interface ReleasePrefillSkipped {
  productId: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  reason: ReleasePrefillSkipReason;
  sumber: PlanReferenceSource;
  acuanQty: number;
  rlPosted: number;
  rlPending: number;
  sisa: number;
  /** Gudang produk bila `GUDANG_LAIN`. */
  warehouseKode?: string;
  warnings?: string[];
}

export interface ReleasePrefill {
  productionPlanId: string;
  lokasiKode: string;
  lines: ReleasePrefillLine[];
  skipped: ReleasePrefillSkipped[];
  summary: { lineCount: number; skippedCount: number; cappedCount: number };
}

export type PrefillProduct = {
  id: string;
  kode?: string;
  nama?: string;
  gudangKode: string;
  baseUomId?: string;
  baseSatuan?: string;
  /** Faktor satuan kemasan ke dasar, per satuan (untuk tampilan). */
  factorBySatuan: Map<string, number>;
};

/**
 * Susun baris RL dari acuan. Murni — semua data stok/produk sudah dimuat.
 * Stok pada salinan katalog lama (`aliasProductIds`) tidak diisi, hanya diberi peringatan.
 */
export function buildReleasePrefill(
  reference: PlanReference,
  lokasiKode: string,
  ctx: { products: Map<string, PrefillProduct>; availableById: Map<string, number> },
): Pick<ReleasePrefill, 'lines' | 'skipped'> {
  const lines: ReleasePrefillLine[] = [];
  const skipped: ReleasePrefillSkipped[] = [];
  const wh = lokasiKode.trim().toUpperCase();

  for (const ref of reference.lines) {
    const rlPending = roundQty(ref.rlPending ?? 0);
    const base = {
      sumber: ref.sumber,
      acuanQty: ref.acuanQty,
      rlPosted: ref.rlPosted,
      rlPending,
      sisa: ref.sisa,
    };
    const warnings = [...(ref.warnings || [])];
    for (const aliasId of ref.aliasProductIds || []) {
      const alias = ctx.products.get(aliasId);
      const qty = roundQty(ctx.availableById.get(aliasId) ?? 0);
      if (!alias || alias.gudangKode !== wh || !(qty > 0)) continue;
      warnings.push(
        `Stok ${qty} ${alias.baseSatuan || ref.satuan || ''} masih di salinan katalog lama `
        + `${alias.kode || aliasId} — tidak diisi otomatis, gabung/pindahkan stoknya dulu`,
      );
    }
    const withWarnings = warnings.length ? { warnings } : {};
    const skip = (reason: ReleasePrefillSkipReason, extra: Partial<ReleasePrefillSkipped> = {}) => {
      skipped.push({
        productId: ref.productId,
        kode: ref.productKode,
        nama: ref.productNama,
        satuan: ref.satuan,
        reason,
        ...base,
        ...extra,
        ...withWarnings,
      });
    };

    const awaitingDelivery = ref.sumber === 'PO' && ref.poQtyOrdered > ref.poQtyReceived;
    if (!(ref.acuanQty > 0) && !(ref.rlPosted > 0) && !(rlPending > 0) && !awaitingDelivery) continue;
    if (!(ref.sisa > 0)) { skip(awaitingDelivery ? 'BELUM_DITERIMA' : 'SELESAI'); continue; }
    const need = Math.max(0, roundQty(ref.sisa - rlPending));
    if (!(need > 0)) { skip('MENUNGGU_RL'); continue; }

    const candidates = ref.productIds
      .map((id) => ctx.products.get(id))
      .filter((p): p is PrefillProduct => Boolean(p) && p!.gudangKode === wh);
    if (!candidates.length) {
      const primary = ctx.products.get(ref.productId);
      skip('GUDANG_LAIN', { warehouseKode: primary?.gudangKode });
      continue;
    }

    let remaining = need;
    const produced: ReleasePrefillLine[] = [];
    for (const p of candidates) {
      if (!(remaining > 0)) break;
      const avail = Math.max(0, roundQty(ctx.availableById.get(p.id) ?? 0));
      const take = roundQty(Math.min(remaining, avail));
      if (!(take > 0)) continue;
      remaining = roundQty(remaining - take);
      const poSatuan = ref.poRefs.find((r) => r.satuan)?.satuan?.trim().toUpperCase();
      const factor = poSatuan ? p.factorBySatuan.get(poSatuan) : undefined;
      produced.push({
        stokId: p.id,
        kode: p.kode || ref.productKode,
        nama: p.nama || ref.productNama,
        uomId: p.baseUomId || '',
        satuan: p.baseSatuan || ref.satuan,
        qty: take,
        qtyBase: take,
        ...(factor && factor !== 1 && poSatuan
          ? { display: { qty: roundQty(take / factor), satuan: poSatuan } }
          : {}),
        ...base,
        stokAvail: avail,
        cappedByStock: false,
        ...withWarnings,
      });
    }
    if (!produced.length) { skip('STOK_KOSONG'); continue; }
    if (remaining > 0) for (const l of produced) l.cappedByStock = true;
    lines.push(...produced);
  }
  return { lines, skipped };
}

async function loadHeldQty(
  db: Db,
  tenantId: string,
  ids: string[],
  lokasiKode: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length || !(await isFoodSafetyHoldEnforced(db, tenantId))) return out;
  const rows = await db.collection(PRODUCTION_BATCHES_COLLECTION)
    .find({
      tenantId,
      finishedGoodProductId: { $in: ids },
      warehouseKode: lokasiKode,
      status: { $in: ['ACTIVE', 'EXPIRED'] },
    })
    .project({ finishedGoodProductId: 1, foodSafetyStatus: 1, qty: 1, qtyRemaining: 1, status: 1 })
    .toArray() as unknown as Array<ProductionBatchDoc & { finishedGoodProductId?: string }>;
  for (const b of rows) {
    if (effectiveFoodSafetyStatus(b) !== 'HOLD') continue;
    const id = String(b.finishedGoodProductId || '');
    out.set(id, roundQty((out.get(id) || 0) + effectiveQtyRemaining(b)));
  }
  return out;
}

export async function loadReleasePrefill(
  db: Db,
  scopeAuth: ScopeAuth,
  plan: PlanReferencePlan,
  opts: {
    lokasiKode: string;
    excludeReleaseId?: string;
    fallbackMrpLines?: PlanReferenceMrpLine[];
  },
): Promise<ReleasePrefill> {
  const tenantId = String(plan.tenantId || '').trim();
  const lokasiKode = opts.lokasiKode.trim().toUpperCase();
  const reference = await loadPlanReference(db, scopeAuth, plan, {
    fallbackMrpLines: opts.fallbackMrpLines,
    pendingRl: { excludeReleaseId: opts.excludeReleaseId },
  });
  const ids = [...new Set(reference.lines.flatMap((l) => [...l.productIds, ...(l.aliasProductIds || [])]))];

  const [productRows, uomsById, stockMap, ledger, held] = await Promise.all([
    db.collection('products')
      .find({ tenantId, id: { $in: ids } })
      .project({ id: 1, kode: 1, nama: 1, satuan: 1, gudangKode: 1 })
      .toArray() as Promise<Array<{ id?: string; kode?: string; nama?: string; satuan?: string; gudangKode?: string }>>,
    listProductUomsByProductIds(db, tenantId, ids),
    getStokByWarehouseBatch(db, tenantId, ids),
    ledgerSaldoForProducts(db, tenantId, ids),
    loadHeldQty(db, tenantId, ids, lokasiKode),
  ]);

  const products = new Map<string, PrefillProduct>();
  for (const p of productRows) {
    const id = String(p.id || '');
    if (!id) continue;
    const uoms = uomsById.get(id) || [];
    const baseUom = pickBaseUom(uoms);
    products.set(id, {
      id,
      kode: p.kode,
      nama: p.nama,
      gudangKode: resolveProductGudangKode(p),
      baseUomId: baseUom?.id,
      baseSatuan: baseUom?.satuan || String(p.satuan || '').trim().toUpperCase() || undefined,
      factorBySatuan: new Map(uoms.map((u) => [String(u.satuan || '').toUpperCase(), Number(u.factorToBase) || 1])),
    });
  }

  const availableById = new Map<string, number>();
  for (const id of ids) {
    const lokasiQty = Number((stockMap.get(id) || {})[lokasiKode] || 0);
    const avail = availableQtyAgainstLedger(lokasiQty, ledger.get(id));
    availableById.set(id, Math.max(0, roundQty(avail - (held.get(id) || 0))));
  }

  const built = buildReleasePrefill(reference, lokasiKode, { products, availableById });
  return {
    productionPlanId: reference.productionPlanId,
    lokasiKode,
    ...built,
    summary: {
      lineCount: built.lines.length,
      skippedCount: built.skipped.length,
      cappedCount: built.lines.filter((l) => l.cappedByStock).length,
    },
  };
}
