import type { Migration, MigrationContext } from '@/lib/migrations/types';
import type { AuthContext } from '@/types/auth';
import { updateRecipeWithRevision } from '@/lib/api/recipe-revisions';
import type { RecipeLine } from '@/lib/food-production/recipe';
import { MENUS_COLLECTION } from '@/lib/food-production/menu';
import { PRODUCTION_PLANS_COLLECTION, type ProductionPlanDoc } from '@/lib/food-production/production-plan';
import { MATERIAL_REQUIREMENTS_COLLECTION } from '@/lib/food-production/material-requirement';
import { isFallbackFactorSource, normalizeRecipeSatuan } from '@/lib/food-production/recipe-uom';
import { backfillLegacyKitchenSatuan } from '@/lib/food-production/recipe-conversion';
import {
  evaluateRecipeLine,
  loadConversionProducts,
  loadRecipesForConversion,
  type RecipeLineConversionRow,
} from '@/lib/api/recipe-conversion-review';
import { regenerateMrpForPlan } from '@/lib/api/handlers/material-requirements';

/** Rencana yang belum Diproses — MRP masih boleh dihitung ulang. */
const REGEN_PLAN_STATUSES = ['SUBMITTED', 'APPROVED'] as const;

type LineReport = Omit<RecipeLineConversionRow, 'nextLine'> & {
  productKode: string;
  productNama: string;
  satuanBackfilled: boolean;
  metadataOnly: boolean;
};

type PlanReport = {
  planId: string;
  noDokumen: string;
  tanggal: string;
  status: string;
  result: 'WOULD_REGENERATE' | 'REGENERATED' | 'NO_MRP' | 'BLOCKED' | 'FAILED';
  mode?: string;
  mrpNo?: string;
  error?: string;
};

function migrationAuth(tenantId: string, actor: string): AuthContext {
  return {
    userId: `migration:${actor}`,
    email: '',
    name: `Migrasi (${actor})`,
    role: 'ADMIN',
    tenantId,
    tenantName: '',
    isMaster: false,
  };
}

async function affectedPlans(
  ctx: MigrationContext,
  recipeIds: string[],
): Promise<ProductionPlanDoc[]> {
  if (!recipeIds.length) return [];
  const menus = await ctx.db.collection(MENUS_COLLECTION)
    .find({ tenantId: ctx.tenantId, 'items.recipeId': { $in: recipeIds } })
    .project({ id: 1 })
    .toArray();
  const menuIds = menus.map((m) => String(m.id));
  const or: Record<string, unknown>[] = [{ 'lines.recipeId': { $in: recipeIds } }];
  if (menuIds.length) or.push({ 'lines.menuId': { $in: menuIds } });
  return ctx.db.collection(PRODUCTION_PLANS_COLLECTION)
    .find({ tenantId: ctx.tenantId, status: { $in: [...REGEN_PLAN_STATUSES] }, $or: or })
    .sort({ tanggal: 1 })
    .toArray() as unknown as Promise<ProductionPlanDoc[]>;
}

export const recomputeRecipeConversionMigration: Migration = {
  id: '0001-recompute-recipe-conversion',
  description: 'Hitung ulang qtyBase/faktor baris resep dengan konversi ketat (tanpa fallback nutrisi/tebakan nama), lalu MRP rencana yang belum Diproses',
  async run(ctx) {
    const actor = ctx.actor || 'system';
    const auth = migrationAuth(ctx.tenantId, actor);
    const recipes = await loadRecipesForConversion(ctx.db, ctx.tenantId);
    const products = await loadConversionProducts(ctx.db, ctx.tenantId, recipes);

    const counts = {
      lines: 0, ok: 0, stale: 0, invalid: 0, metadataOnly: 0, satuanBackfilled: 0, cutover: 0,
      fallbackBefore: 0, fallbackAfter: 0,
    };
    const lineReports: LineReport[] = [];
    const recipeResults: Array<{ recipeId: string; kode: string; nama: string; changedLines: number; result: string }> = [];
    const valueChangedRecipeIds: string[] = [];
    let changed = 0;

    for (const recipe of recipes) {
      const lines = recipe.lines || [];
      let valueChanges = 0;
      let metaChanges = 0;
      const nextLines: RecipeLine[] = lines.map((line, idx) => {
        counts.lines += 1;
        const wasFallback = isFallbackFactorSource(line.factorSource);
        if (wasFallback) counts.fallbackBefore += 1;
        const p = products.get(line.productId);
        if (!p) {
          counts.invalid += 1;
          if (wasFallback) counts.fallbackAfter += 1;
          lineReports.push({
            recipeId: recipe.id,
            recipeKode: String(recipe.kode || ''),
            recipeNama: String(recipe.nama || ''),
            recipeAktif: recipe.aktif !== false,
            lineIndex: idx,
            productId: line.productId,
            liveProductId: line.productId,
            productKode: String(line.productKode || ''),
            productNama: String(line.productNama || ''),
            satuan: normalizeRecipeSatuan(line.satuan),
            baseSatuan: normalizeRecipeSatuan(line.baseSatuan),
            before: {
              factorToBase: line.factorToBase ?? null,
              factorSource: line.factorSource ?? null,
              qtyBaseBesar: line.qtyBaseBesar ?? null,
              qtyBaseKecil: line.qtyBaseKecil ?? null,
            },
            after: null,
            status: 'INVALID',
            cutover: false,
            error: 'Produk tidak ditemukan di master tenant',
            satuanBackfilled: false,
            metadataOnly: false,
          });
          return line;
        }
        const cutover = String(p.id || line.productId) !== line.productId;
        const prepped = backfillLegacyKitchenSatuan(line, String(p.satuan || ''), cutover);
        const row = evaluateRecipeLine(recipe, prepped.line, idx, p);
        const { nextLine, ...rest } = row;
        const metadataOnly = row.status === 'OK' && Boolean(nextLine) && !prepped.filled;
        if (row.status === 'OK') counts.ok += 1;
        else if (row.status === 'STALE') counts.stale += 1;
        else counts.invalid += 1;
        if (metadataOnly) counts.metadataOnly += 1;
        if (row.cutover) counts.cutover += 1;
        if (prepped.filled && nextLine) counts.satuanBackfilled += 1;

        if (row.status !== 'OK' || prepped.filled) {
          lineReports.push({
            ...rest,
            productKode: String(p.kode || line.productKode || ''),
            productNama: String(p.nama || line.productNama || ''),
            satuanBackfilled: prepped.filled && Boolean(nextLine),
            metadataOnly,
          });
        }
        if (isFallbackFactorSource((nextLine || line).factorSource)) counts.fallbackAfter += 1;
        if (!nextLine) return line;
        if (metadataOnly) metaChanges += 1;
        else valueChanges += 1;
        return nextLine;
      });

      if (!valueChanges && !metaChanges) continue;
      if (valueChanges) valueChangedRecipeIds.push(recipe.id);
      if (ctx.dryRun) {
        recipeResults.push({
          recipeId: recipe.id,
          kode: String(recipe.kode || ''),
          nama: String(recipe.nama || ''),
          changedLines: valueChanges + metaChanges,
          result: 'WOULD_UPDATE',
        });
        continue;
      }
      const res = await updateRecipeWithRevision(
        ctx.db,
        recipe,
        { lines: nextLines, updatedAt: ctx.now, conversionRecomputedAt: ctx.now },
        {
          reason: 'RECOMPUTE',
          actor: { userId: auth.userId, userName: auth.name },
          now: ctx.now,
          audit: (revisions) => ({
            tenantId: ctx.tenantId,
            action: 'RECIPE_CONVERSION_RECOMPUTE',
            entityType: 'recipe',
            entityId: recipe.id,
            summary: `Resep ${recipe.kode}: ${valueChanges} baris dihitung ulang, ${metaChanges} baris metadata`,
            metadata: {
              migration: '0001-recompute-recipe-conversion',
              valueChanges,
              metaChanges,
              revisions: revisions.map((r) => ({ id: r.id, revision: r.revision, reason: r.reason })),
            },
            userId: auth.userId,
            userName: auth.name,
          }),
        },
      );
      const conflict = !res.ok;
      recipeResults.push({
        recipeId: recipe.id,
        kode: String(recipe.kode || ''),
        nama: String(recipe.nama || ''),
        changedLines: valueChanges + metaChanges,
        result: conflict ? 'CONFLICT' : 'UPDATED',
      });
      if (!conflict) changed += 1;
      else if (valueChanges) valueChangedRecipeIds.pop();
    }

    const plans = await affectedPlans(ctx, valueChangedRecipeIds);
    const planReports: PlanReport[] = [];
    for (const plan of plans) {
      const base = { planId: plan.id, noDokumen: plan.noDokumen, tanggal: String(plan.tanggal || ''), status: plan.status };
      const openMrp = await ctx.db.collection(MATERIAL_REQUIREMENTS_COLLECTION).countDocuments(
        { tenantId: ctx.tenantId, productionPlanId: plan.id, status: { $nin: ['CANCELLED'] } },
        { limit: 1 },
      );
      if (!openMrp) {
        planReports.push({ ...base, result: 'NO_MRP' });
        continue;
      }
      if (ctx.dryRun) {
        planReports.push({ ...base, result: 'WOULD_REGENERATE' });
        continue;
      }
      const res = await regenerateMrpForPlan(ctx.db, auth, plan, {
        actor: { userId: auth.userId, userName: auth.name },
        reason: 'hitung ulang konversi resep (migrasi 0001)',
      });
      if (res.ok) {
        changed += 1;
        planReports.push({
          ...base,
          result: 'REGENERATED',
          mode: res.mode,
          mrpNo: res.mrp ? String((res.mrp as { noDokumen?: string }).noDokumen || '') : undefined,
        });
      } else {
        planReports.push({ ...base, result: res.blocked ? 'BLOCKED' : 'FAILED', error: res.error });
      }
    }

    const recipesTouched = recipeResults.length;
    return {
      summary: `${counts.lines} baris resep: ${counts.stale} dihitung ulang, ${counts.invalid} belum valid, `
        + `${counts.metadataOnly} metadata; fallback ${counts.fallbackBefore} → ${counts.fallbackAfter}; `
        + `${recipesTouched} resep, ${planReports.filter((p) => p.result === 'REGENERATED' || p.result === 'WOULD_REGENERATE').length} MRP rencana`
        + (counts.invalid ? ' — lengkapi Review konversi sebelum menyalakan strictRecipeConversion' : ''),
      before: {
        lines: counts.lines,
        okLines: counts.ok,
        staleLines: counts.stale,
        invalidLines: counts.invalid,
        fallbackLines: counts.fallbackBefore,
      },
      after: {
        readyForStrict: counts.invalid === 0,
        fallbackLines: counts.fallbackAfter,
        okLines: counts.ok + counts.stale,
        invalidLines: counts.invalid,
        metadataOnly: counts.metadataOnly,
        satuanBackfilled: counts.satuanBackfilled,
        cutoverLines: counts.cutover,
        recipes: recipeResults,
        plans: planReports,
        lines: lineReports,
      },
      changed,
    };
  },
};
