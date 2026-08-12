/**
 * ADR-004 Fase 6 — Traceability read-model (candidate-lot inference).
 * Bukan ledger baru. lastConsumedBy dilarang sebagai sumber.
 */

import type { Db } from 'mongodb';
import {
  INGREDIENT_LOTS_COLLECTION,
  type IngredientLotDoc,
} from '@/lib/food-production/ingredient-lot';
import {
  MATERIAL_ISSUES_COLLECTION,
  type MaterialIssueDoc,
} from '@/lib/food-production/material-issue';
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
  type MaterialRequirementDoc,
} from '@/lib/food-production/material-requirement';
import {
  PRODUCTION_BATCHES_COLLECTION,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import {
  DISTRIBUTION_ORDERS_COLLECTION,
  type DispatchDoc,
} from '@/lib/food-production/distribution';
import { RECIPES_COLLECTION } from '@/lib/food-production/recipe';

export const TRACEABILITY_ATTRIBUTION_DISCLAIMER =
  'Traceability attribution is a candidate-lot inference based on recorded material allocation, not a physical observation.';

export type TraceDirection = 'BACKWARD' | 'FORWARD';

export interface CandidateLotRef {
  lotId: string;
  lotNo?: string;
  productId?: string;
  productKode?: string;
  productNama?: string;
  grnId?: string;
  noGRN?: string;
  supplierId?: string;
  expiryDate?: string;
  /** Qty dialokasikan di issue (superset; boleh overlapping antar batch plan). */
  allocatedQty: number;
  /** Share proporsional 0–1 bila MRP sources bisa dihitung; else undefined. */
  weightShare?: number;
  issueId?: string;
  issueNo?: string;
}

export interface CandidateBatchRef {
  batchId: string;
  batchNo?: string;
  productionPlanId?: string;
  finishedGoodNama?: string;
  foodSafetyStatus?: string;
  allocatedQty?: number;
  distributionIds?: string[];
}

export interface TraceabilityResult {
  direction: TraceDirection;
  attribution: 'CANDIDATE_LOT_INFERENCE';
  disclaimer: string;
  productionBatchId?: string;
  ingredientLotId?: string;
  candidateLots: CandidateLotRef[];
  candidateBatches: CandidateBatchRef[];
}

type AllocationLike = { batchId?: string; batchNo?: string; qty?: number; expiryDate?: string };

function parseAllocations(raw: unknown): AllocationLike[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => {
    const row = (a || {}) as Record<string, unknown>;
    return {
      batchId: String(row.batchId || '').trim() || undefined,
      batchNo: String(row.batchNo || '').trim() || undefined,
      qty: Number(row.qty) || 0,
      expiryDate: String(row.expiryDate || '').trim() || undefined,
    };
  }).filter((a) => a.batchId);
}

/**
 * Hitung share proporsional untuk product line terhadap recipe yang menghasilkan FG.
 * Jika tidak ada match recipe → undefined (tetap tampilkan full candidate).
 */
export function proportionalShareForFinishedGood(input: {
  mrpLineSources: Array<{ recipeId: string; qty: number }>;
  /** recipeId yang menghasilkan finished good batch (bila diketahui). */
  finishedGoodRecipeIds: string[];
}): number | undefined {
  const total = input.mrpLineSources.reduce((s, x) => s + (Number(x.qty) || 0), 0);
  if (!(total > 0) || !input.finishedGoodRecipeIds.length) return undefined;
  const fgSet = new Set(input.finishedGoodRecipeIds);
  const fgQty = input.mrpLineSources
    .filter((s) => fgSet.has(s.recipeId))
    .reduce((s, x) => s + (Number(x.qty) || 0), 0);
  if (!(fgQty > 0)) return undefined;
  return Math.min(1, fgQty / total);
}

export function mergeCandidateLots(
  rows: CandidateLotRef[],
): CandidateLotRef[] {
  const byId = new Map<string, CandidateLotRef>();
  for (const r of rows) {
    const prev = byId.get(r.lotId);
    if (!prev) {
      byId.set(r.lotId, { ...r });
      continue;
    }
    prev.allocatedQty += r.allocatedQty;
    if (r.weightShare != null) {
      prev.weightShare = Math.max(prev.weightShare || 0, r.weightShare);
    }
  }
  return [...byId.values()].sort((a, b) => b.allocatedQty - a.allocatedQty);
}

/**
 * Backward: production batch → candidate ingredient lots (+ supplierId).
 */
export async function traceBatchBackward(
  db: Db,
  input: { tenantId: string; productionBatchId: string },
): Promise<TraceabilityResult | { error: string }> {
  const batch = await db.collection(PRODUCTION_BATCHES_COLLECTION).findOne({
    tenantId: input.tenantId,
    id: input.productionBatchId,
  }) as ProductionBatchDoc | null;
  if (!batch) return { error: 'Batch tidak ditemukan' };

  const issues = await db.collection(MATERIAL_ISSUES_COLLECTION).find({
    tenantId: input.tenantId,
    productionPlanId: batch.productionPlanId,
    status: { $nin: ['CANCELLED'] },
  }).toArray() as unknown as MaterialIssueDoc[];

  const mrp = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne({
    tenantId: input.tenantId,
    productionPlanId: batch.productionPlanId,
    status: { $nin: ['CANCELLED'] },
  }) as MaterialRequirementDoc | null;

  const sourcesByProduct = new Map<string, Array<{ recipeId: string; qty: number }>>();
  for (const line of mrp?.lines || []) {
    sourcesByProduct.set(
      line.productId,
      (line.sources || []).map((s) => ({ recipeId: s.recipeId, qty: Number(s.qty) || 0 })),
    );
  }

  // Recipe IDs yang menghasilkan FG batch ini → share proporsional ADR §10.
  const fgProductId = String(batch.finishedGoodProductId || '').trim();
  let finishedGoodRecipeIds: string[] = [];
  if (fgProductId) {
    const fgRecipes = await db.collection(RECIPES_COLLECTION).find({
      tenantId: input.tenantId,
      finishedGoodProductId: fgProductId,
      aktif: { $ne: false },
    }).project({ id: 1 }).limit(50).toArray();
    finishedGoodRecipeIds = fgRecipes.map((r) => String(r.id)).filter(Boolean);
  }
  // Fallback: recipeIds unik dari seluruh MRP sources bila FG mapping kosong.
  if (!finishedGoodRecipeIds.length && mrp?.lines?.length) {
    const fromSources = new Set<string>();
    for (const line of mrp.lines) {
      for (const s of line.sources || []) {
        if (s.recipeId) fromSources.add(s.recipeId);
      }
    }
    // Hanya pakai fallback single-recipe (share=1); multi tanpa FG map → undefined (superset).
    if (fromSources.size === 1) finishedGoodRecipeIds = [...fromSources];
  }

  const candidateRaw: CandidateLotRef[] = [];
  const lotIds = new Set<string>();

  for (const issue of issues) {
    for (const fc of issue.fefoConsume || []) {
      const allocs = parseAllocations(fc.allocations);
      const sources = sourcesByProduct.get(fc.stokId) || [];
      const share = proportionalShareForFinishedGood({
        mrpLineSources: sources,
        finishedGoodRecipeIds,
      });
      for (const a of allocs) {
        if (!a.batchId) continue;
        lotIds.add(a.batchId);
        // Qty tetap full (superset recall-safe); weightShare informasional proporsional.
        candidateRaw.push({
          lotId: a.batchId,
          lotNo: a.batchNo,
          productId: fc.stokId,
          allocatedQty: a.qty || 0,
          weightShare: share,
          issueId: issue.id,
          issueNo: issue.noDokumen,
        });
      }
    }
  }

  const lots = lotIds.size
    ? await db.collection(INGREDIENT_LOTS_COLLECTION).find({
      tenantId: input.tenantId,
      id: { $in: [...lotIds] },
    }).toArray() as unknown as IngredientLotDoc[]
    : [];
  const lotById = new Map(lots.map((l) => [l.id, l]));

  const enriched = mergeCandidateLots(candidateRaw).map((c) => {
    const lot = lotById.get(c.lotId);
    return {
      ...c,
      lotNo: c.lotNo || lot?.lotNo,
      productId: c.productId || lot?.productId,
      productKode: lot?.productKode,
      productNama: lot?.productNama,
      grnId: lot?.grnId,
      noGRN: lot?.noGRN,
      supplierId: lot?.supplierId,
      expiryDate: lot?.expiryDate || c.expiryDate,
    };
  });

  return {
    direction: 'BACKWARD',
    attribution: 'CANDIDATE_LOT_INFERENCE',
    disclaimer: TRACEABILITY_ATTRIBUTION_DISCLAIMER,
    productionBatchId: batch.id,
    candidateLots: enriched,
    candidateBatches: [{
      batchId: batch.id,
      batchNo: batch.batchNo,
      productionPlanId: batch.productionPlanId,
      finishedGoodNama: batch.finishedGoodNama,
      foodSafetyStatus: batch.foodSafetyStatus,
    }],
  };
}

/**
 * Forward: ingredient lot → candidate production batches (+ distribusi).
 */
export async function traceLotForward(
  db: Db,
  input: { tenantId: string; ingredientLotId: string },
): Promise<TraceabilityResult | { error: string }> {
  const lot = await db.collection(INGREDIENT_LOTS_COLLECTION).findOne({
    tenantId: input.tenantId,
    id: input.ingredientLotId,
  }) as IngredientLotDoc | null;
  if (!lot) return { error: 'Ingredient lot tidak ditemukan' };

  const issues = await db.collection(MATERIAL_ISSUES_COLLECTION).find({
    tenantId: input.tenantId,
    status: { $nin: ['CANCELLED'] },
    'fefoConsume.allocations.batchId': input.ingredientLotId,
  }).limit(200).toArray() as unknown as MaterialIssueDoc[];

  // Fallback scan bila index path tidak match nested shape lama.
  let usedIssues = issues;
  if (!usedIssues.length) {
    const recent = await db.collection(MATERIAL_ISSUES_COLLECTION).find({
      tenantId: input.tenantId,
      status: { $nin: ['CANCELLED'] },
    }).sort({ updatedAt: -1 }).limit(300).toArray() as unknown as MaterialIssueDoc[];
    usedIssues = recent.filter((iss) =>
      (iss.fefoConsume || []).some((fc) =>
        parseAllocations(fc.allocations).some((a) => a.batchId === input.ingredientLotId),
      ),
    );
  }

  const planIds = [...new Set(usedIssues.map((i) => i.productionPlanId).filter(Boolean))];
  const batches = planIds.length
    ? await db.collection(PRODUCTION_BATCHES_COLLECTION).find({
      tenantId: input.tenantId,
      productionPlanId: { $in: planIds },
    }).toArray() as unknown as ProductionBatchDoc[]
    : [];

  const batchIds = batches.map((b) => b.id);
  const dists = batchIds.length
    ? await db.collection(DISTRIBUTION_ORDERS_COLLECTION).find({
      tenantId: input.tenantId,
      status: { $nin: ['CANCELLED'] },
      $or: [
        { productionPlanId: { $in: planIds } },
        { 'fefoConsume.allocations.batchId': { $in: batchIds } },
      ],
    }).limit(200).toArray() as unknown as DispatchDoc[]
    : [];

  const distByBatch = new Map<string, string[]>();
  for (const d of dists) {
    for (const fc of d.fefoConsume || []) {
      for (const a of parseAllocations(fc.allocations)) {
        if (!a.batchId) continue;
        const list = distByBatch.get(a.batchId) || [];
        list.push(d.id);
        distByBatch.set(a.batchId, list);
      }
    }
    // Plan-level link tanpa alloc detail → semua batch plan
    if (!(d.fefoConsume || []).length && d.productionPlanId) {
      for (const b of batches.filter((x) => x.productionPlanId === d.productionPlanId)) {
        const list = distByBatch.get(b.id) || [];
        list.push(d.id);
        distByBatch.set(b.id, list);
      }
    }
  }

  let allocatedOnLot = 0;
  for (const iss of usedIssues) {
    for (const fc of iss.fefoConsume || []) {
      for (const a of parseAllocations(fc.allocations)) {
        if (a.batchId === lot.id) allocatedOnLot += a.qty || 0;
      }
    }
  }

  return {
    direction: 'FORWARD',
    attribution: 'CANDIDATE_LOT_INFERENCE',
    disclaimer: TRACEABILITY_ATTRIBUTION_DISCLAIMER,
    ingredientLotId: lot.id,
    candidateLots: [{
      lotId: lot.id,
      lotNo: lot.lotNo,
      productId: lot.productId,
      productKode: lot.productKode,
      productNama: lot.productNama,
      grnId: lot.grnId,
      noGRN: lot.noGRN,
      supplierId: lot.supplierId,
      expiryDate: lot.expiryDate,
      allocatedQty: allocatedOnLot,
    }],
    candidateBatches: batches.map((b) => ({
      batchId: b.id,
      batchNo: b.batchNo,
      productionPlanId: b.productionPlanId,
      finishedGoodNama: b.finishedGoodNama,
      foodSafetyStatus: b.foodSafetyStatus,
      distributionIds: [...new Set(distByBatch.get(b.id) || [])],
    })),
  };
}
