import type { Migration } from '@/lib/migrations/types';
import { writeAuditLog } from '@/lib/api/audit-log';
import { ensureRecipeRevisions, type RecipeWithState } from '@/lib/api/recipe-revisions';
import { RECIPES_COLLECTION } from '@/lib/food-production/recipe';
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
  type MaterialRequirementDoc,
} from '@/lib/food-production/material-requirement';
import type { RecipeRevisionPin } from '@/lib/food-production/recipe-revision';

type MrpReport = {
  mrpId: string;
  noDokumen: string;
  status: string;
  recipes: number;
  result: 'WOULD_PIN' | 'PINNED' | 'CONFLICT' | 'NO_RECIPE';
  missingRecipeIds?: string[];
};

function mrpRecipeIds(mrp: Pick<MaterialRequirementDoc, 'lines'>): string[] {
  const ids = new Set<string>();
  for (const line of mrp.lines || []) {
    for (const s of line.sources || []) if (s.recipeId) ids.add(s.recipeId);
  }
  return [...ids];
}

/**
 * Revisi 1 (BACKFILL) untuk resep yang belum punya revisi, lalu pin revisi itu ke MRP terbuka
 * yang belum mencatat revisi. Isi MRP lama tidak diketahui revisinya secara pasti, jadi pin ditandai
 * `recipeRevisionsBackfilled` (isi resep saat migrasi). Idempoten.
 */
export const backfillRecipeRevisionsMigration: Migration = {
  id: '0002-backfill-recipe-revisions',
  description: 'Revisi awal untuk resep lama dan pin revisi resep ke MRP yang belum Dibatalkan',
  async run(ctx) {
    const actor = ctx.actor || 'system';
    const revisionActor = { userId: `migration:${actor}`, userName: `Migrasi (${actor})` };
    const tenantId = ctx.tenantId;

    const recipes = await ctx.db.collection(RECIPES_COLLECTION)
      .find({ tenantId })
      .project({ _id: 0 })
      .toArray() as unknown as RecipeWithState[];
    const unrevised = recipes.filter((r) => !r.currentRevisionId);

    const mrps = await ctx.db.collection(MATERIAL_REQUIREMENTS_COLLECTION)
      .find({ tenantId, status: { $nin: ['CANCELLED'] }, 'recipeRevisions.0': { $exists: false } })
      .project({ _id: 0, id: 1, noDokumen: 1, status: 1, updatedAt: 1, lines: 1 })
      .toArray() as unknown as Array<Pick<MaterialRequirementDoc, 'id' | 'noDokumen' | 'status' | 'updatedAt' | 'lines'>>;

    const before = {
      recipes: recipes.length,
      recipesWithoutRevision: unrevised.length,
      openMrpsWithoutPins: mrps.length,
    };

    const recipeById = new Map(recipes.map((r) => [r.id, r]));
    let pins = new Map<string, RecipeRevisionPin>();
    let changed = 0;
    if (!ctx.dryRun) {
      pins = await ensureRecipeRevisions(ctx.db, recipes, revisionActor);
      changed += unrevised.filter((r) => pins.has(r.id)).length;
    }

    const mrpReports: MrpReport[] = [];
    for (const mrp of mrps) {
      const ids = mrpRecipeIds(mrp);
      const missing = ids.filter((id) => !recipeById.has(id));
      const base = {
        mrpId: mrp.id,
        noDokumen: mrp.noDokumen,
        status: mrp.status,
        recipes: ids.length,
        ...(missing.length ? { missingRecipeIds: missing } : {}),
      };
      if (!ids.length || missing.length === ids.length) {
        mrpReports.push({ ...base, result: 'NO_RECIPE' });
        continue;
      }
      if (ctx.dryRun) {
        mrpReports.push({ ...base, result: 'WOULD_PIN' });
        continue;
      }
      const recipeRevisions = ids.map((id) => pins.get(id)).filter((p): p is RecipeRevisionPin => Boolean(p));
      const lines = (mrp.lines || []).map((l) => ({
        ...l,
        sources: (l.sources || []).map((s) => ({ ...s, recipeRevisionId: pins.get(s.recipeId)?.revisionId ?? null })),
      }));
      // updatedAt sengaja tidak diubah: pin revisi bukan edit isi MRP (tidak memicu konflik edit pengguna).
      const res = await ctx.db.collection(MATERIAL_REQUIREMENTS_COLLECTION).updateOne(
        {
          tenantId,
          id: mrp.id,
          updatedAt: mrp.updatedAt ?? null,
          'recipeRevisions.0': { $exists: false },
        },
        { $set: { lines, recipeRevisions, recipeRevisionsBackfilled: true } },
      );
      if (res.matchedCount === 0) {
        mrpReports.push({ ...base, result: 'CONFLICT' });
        continue;
      }
      changed += 1;
      mrpReports.push({ ...base, result: 'PINNED' });
    }

    if (!ctx.dryRun && changed) {
      await writeAuditLog(ctx.db, {
        tenantId,
        action: 'RECIPE_REVISION_BACKFILL',
        entityType: 'recipe',
        entityId: tenantId,
        summary: `Revisi awal ${unrevised.length} resep, pin revisi ${mrpReports.filter((m) => m.result === 'PINNED').length} MRP`,
        metadata: { migration: '0002-backfill-recipe-revisions' },
        ...revisionActor,
      });
    }

    const countBy = (r: MrpReport['result']) => mrpReports.filter((m) => m.result === r).length;
    const recipeVerb = ctx.dryRun ? 'akan diberi' : 'diberi';
    return {
      summary: `${unrevised.length}/${recipes.length} resep ${recipeVerb} revisi awal; `
        + `${ctx.dryRun ? countBy('WOULD_PIN') : countBy('PINNED')}/${mrps.length} MRP terbuka ${ctx.dryRun ? 'akan ' : ''}dipin`
        + (countBy('NO_RECIPE') ? `; ${countBy('NO_RECIPE')} MRP tanpa resep tersisa` : '')
        + (countBy('CONFLICT') ? `; ${countBy('CONFLICT')} MRP berubah saat migrasi (jalankan ulang)` : ''),
      before,
      after: {
        recipesBackfilled: ctx.dryRun ? 0 : unrevised.filter((r) => pins.has(r.id)).length,
        recipesToBackfill: unrevised.map((r) => ({ id: r.id, kode: r.kode, nama: r.nama })),
        mrps: mrpReports,
      },
      changed,
    };
  },
};
