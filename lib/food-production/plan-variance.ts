/**
 * Varians per rencana (Fase 6): rencana MRP vs acuan PO vs pemakaian aktual (RL POSTED + PBL bermutasi),
 * qty satuan dasar dan rupiah per produk. Nilai aktual dari kartu stok (harga saat keluar); PO dari GRN
 * POSTED rencana (harga terima), atau estimasi PO bila belum ada GRN; MRP dinilai harga rata-rata produk.
 */

import type { Db } from 'mongodb';
import { withTenantFilter } from '@/lib/api/tenant-master';
import { MATERIAL_ISSUES_COLLECTION } from '@/lib/food-production/material-issue';
import { INVENTORY_RELEASES_COLLECTION, RL_POSTED_STATUSES } from '@/lib/food-production/material-issue-reconcile';
import {
  CUSTOMER_POS_COLLECTION,
  loadPlanReference,
  type PlanReferenceLine,
  type PlanReferenceMrpLine,
  type PlanReferenceSource,
} from '@/lib/food-production/plan-reference';
import { sumOutboundKartuBySource } from '@/lib/stock-ledger/kartu-read';
import { roundMoney, roundQty, roundUnitCost } from '@/lib/stock-ledger/precision';

type ScopeAuth = Parameters<typeof withTenantFilter>[0];

export type VarianceCostBasis = 'KARTU' | 'PO' | 'AVG' | 'NONE';

export interface PlanVarianceLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  sumber: PlanReferenceSource;
  qtyMrp: number;
  qtyPoOrdered: number;
  qtyPoReceived: number;
  acuanQty: number;
  qtyRl: number;
  qtyPbl: number;
  qtyActual: number;
  /** qtyActual − acuanQty (positif = lebih keluar dari acuan). */
  varianceQty: number;
  variancePct: number | null;
  unitCost: number;
  costBasis: VarianceCostBasis;
  amountMrp: number;
  amountPo: number;
  amountActual: number;
  amountAcuan: number;
  varianceAmount: number;
  /** Qty keluar yang kartunya tanpa harga; dinilai harga rata-rata produk. */
  zeroCostQty: number;
}

export interface PlanVariance {
  productionPlanId: string;
  lines: PlanVarianceLine[];
  summary: {
    lineCount: number;
    overCount: number;
    underCount: number;
    amountMrp: number;
    amountPo: number;
    amountActual: number;
    amountAcuan: number;
    varianceAmount: number;
    zeroCostLines: number;
  };
}

type Acc = { amount: number; qty: number; zeroCostQty: number };

function lineIndex(lines: PlanReferenceLine[]) {
  const byId = new Map<string, PlanReferenceLine>();
  for (const l of lines) {
    for (const id of [l.productId, ...l.productIds, ...(l.aliasProductIds || [])]) {
      if (!byId.has(id)) byId.set(id, l);
    }
  }
  return byId;
}

export async function buildPlanVariance(
  db: Db,
  scopeAuth: ScopeAuth,
  plan: { id: string; tenantId: string },
  opts: { fallbackMrpLines?: PlanReferenceMrpLine[] } = {},
): Promise<PlanVariance> {
  const tenantId = plan.tenantId;
  const [reference, releases, issues, pos] = await Promise.all([
    loadPlanReference(db, scopeAuth, plan, { fallbackMrpLines: opts.fallbackMrpLines }),
    db.collection(INVENTORY_RELEASES_COLLECTION)
      .find(withTenantFilter(scopeAuth, { productionPlanId: plan.id, status: { $in: [...RL_POSTED_STATUSES] } }))
      .project({ id: 1, noRelease: 1 })
      .toArray(),
    db.collection(MATERIAL_ISSUES_COLLECTION)
      .find(withTenantFilter(scopeAuth, {
        productionPlanId: plan.id,
        status: 'COMPLETED',
        stockMode: { $ne: 'REFERENCE' },
        stockPostedAt: { $exists: true, $ne: null },
      }))
      .project({ id: 1, noDokumen: 1 })
      .toArray(),
    db.collection(CUSTOMER_POS_COLLECTION)
      .find(withTenantFilter(scopeAuth, { productionPlanId: plan.id, status: { $nin: ['CANCELLED'] } }))
      .project({ noPO: 1, items: 1 })
      .toArray(),
  ]);
  const byId = lineIndex(reference.lines);
  const keyOf = (productId: string) => byId.get(productId)?.productId;

  const kartu = await sumOutboundKartuBySource(db, {
    tenantId,
    sources: [
      { sourceType: 'RELEASE', sourceIds: releases.map((r) => String(r.id)), docNos: releases.map((r) => String(r.noRelease || '')) },
      { sourceType: 'FP_ISSUE', sourceIds: issues.map((i) => String(i.id)), docNos: issues.map((i) => String(i.noDokumen || '')) },
    ],
  });
  const actual = new Map<string, Acc>();
  for (const k of kartu.values()) {
    const key = keyOf(k.productId);
    if (!key) continue;
    const cur = actual.get(key) || { amount: 0, qty: 0, zeroCostQty: 0 };
    cur.amount += k.amount;
    cur.qty += k.qtyOut;
    cur.zeroCostQty += k.zeroCostQty;
    actual.set(key, cur);
  }

  const noPOs = pos.map((p) => String(p.noPO || '')).filter(Boolean);
  const grns = noPOs.length
    ? await db.collection('goods_receipts')
      .find({ tenantId, noPO: { $in: noPOs }, status: 'POSTED' })
      .project({ items: 1 })
      .toArray()
    : [];
  const poValue = new Map<string, number>();
  for (const g of grns) {
    for (const it of (g.items || []) as Array<Record<string, unknown>>) {
      const key = keyOf(String(it.localStokId || ''));
      if (!key) continue;
      const v = (Number(it.qtyReceived) || 0) * (Number(it.harga ?? it.hargaSatuan) || 0);
      poValue.set(key, (poValue.get(key) || 0) + v);
    }
  }
  const poEstimate = new Map<string, number>();
  for (const p of pos) {
    for (const it of (p.items || []) as Array<Record<string, unknown>>) {
      if (it.cancelled) continue;
      const key = keyOf(String(it.localStokId || ''));
      if (!key) continue;
      const v = (Number(it.qtyReceived) || 0) * (Number(it.estimasiHarga ?? it.hargaBeliReferensi) || 0);
      poEstimate.set(key, (poEstimate.get(key) || 0) + v);
    }
  }

  const products = await db.collection('products')
    .find({ tenantId, id: { $in: reference.lines.map((l) => l.productId) } })
    .project({ id: 1, avgCost: 1, hargaBeli: 1 })
    .toArray();
  const avgById = new Map(products.map((p) => {
    const avg = roundUnitCost(p.avgCost as number);
    return [String(p.id), avg > 0 ? avg : roundUnitCost(p.hargaBeli as number)];
  }));

  const lines: PlanVarianceLine[] = reference.lines.map((l) => {
    const avg = avgById.get(l.productId) || 0;
    const act = actual.get(l.productId) || { amount: 0, qty: 0, zeroCostQty: 0 };
    const pricedQty = act.qty - act.zeroCostQty;
    const amountActual = roundMoney(act.amount + act.zeroCostQty * avg);
    const amountPo = roundMoney(poValue.get(l.productId) || poEstimate.get(l.productId) || 0);
    let unitCost = 0;
    let costBasis: VarianceCostBasis = 'NONE';
    if (pricedQty > 0 && act.amount > 0) {
      unitCost = roundUnitCost(act.amount / pricedQty);
      costBasis = 'KARTU';
    } else if (l.poQtyReceived > 0 && amountPo > 0) {
      unitCost = roundUnitCost(amountPo / l.poQtyReceived);
      costBasis = 'PO';
    } else if (avg > 0) {
      unitCost = avg;
      costBasis = 'AVG';
    }
    const qtyActual = roundQty(l.rlPosted + l.pblPosted);
    const varianceQty = roundQty(qtyActual - l.acuanQty);
    const amountAcuan = roundMoney(l.acuanQty * unitCost);
    return {
      productId: l.productId,
      productKode: l.productKode,
      productNama: l.productNama,
      satuan: l.satuan,
      sumber: l.sumber,
      qtyMrp: l.qtyMrp,
      qtyPoOrdered: l.poQtyOrdered,
      qtyPoReceived: l.poQtyReceived,
      acuanQty: l.acuanQty,
      qtyRl: l.rlPosted,
      qtyPbl: l.pblPosted,
      qtyActual,
      varianceQty,
      variancePct: l.acuanQty > 0 ? roundMoney((varianceQty / l.acuanQty) * 100) : null,
      unitCost,
      costBasis,
      amountMrp: roundMoney(l.qtyMrp * avg),
      amountPo,
      amountActual,
      amountAcuan,
      varianceAmount: roundMoney(amountActual - amountAcuan),
      zeroCostQty: roundQty(act.zeroCostQty),
    };
  });
  lines.sort((a, b) => Math.abs(b.varianceAmount) - Math.abs(a.varianceAmount)
    || String(a.productNama || '').localeCompare(String(b.productNama || '')));

  const sum = (f: (l: PlanVarianceLine) => number) => roundMoney(lines.reduce((s, l) => s + f(l), 0));
  return {
    productionPlanId: plan.id,
    lines,
    summary: {
      lineCount: lines.length,
      overCount: lines.filter((l) => l.varianceQty > 0).length,
      underCount: lines.filter((l) => l.varianceQty < 0).length,
      amountMrp: sum((l) => l.amountMrp),
      amountPo: sum((l) => l.amountPo),
      amountActual: sum((l) => l.amountActual),
      amountAcuan: sum((l) => l.amountAcuan),
      varianceAmount: sum((l) => l.varianceAmount),
      zeroCostLines: lines.filter((l) => l.zeroCostQty > 0).length,
    },
  };
}
