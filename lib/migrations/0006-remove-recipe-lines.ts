import type { Migration } from '@/lib/migrations/types';
import { updateRecipeWithRevision, type RecipeWithState } from '@/lib/api/recipe-revisions';
import { RECIPES_COLLECTION } from '@/lib/food-production/recipe';

export const REMOVE_RECIPE_LINES_ID = '0006-remove-recipe-lines';

/** Keputusan: `[{ "recipeKode": "RSP-0043", "productId": "...", "productKode": "B799228", "satuan": "GR" }]`. */
export type RemoveRecipeLineDecision = {
  recipeKode: string;
  productId: string;
  productKode?: string;
  satuan?: string;
};

export type RemoveRecipeLineResult = RemoveRecipeLineDecision & {
  recipeId?: string;
  removedLines: number;
  result: 'WOULD_REMOVE' | 'REMOVED' | 'NOT_FOUND' | 'MISMATCH' | 'CONFLICT' | 'EMPTY_RECIPE';
  detail?: string;
};

export function parseRemoveRecipeLineDecisions(raw: unknown): RemoveRecipeLineDecision[] {
  const src = raw && typeof raw === 'object' && 'decisions' in (raw as Record<string, unknown>)
    ? (raw as { decisions: unknown }).decisions
    : raw;
  if (!Array.isArray(src)) return [];
  return src
    .map((d) => d as Record<string, unknown>)
    .map((d) => ({
      recipeKode: String(d.recipeKode || '').trim(),
      productId: String(d.productId || '').trim(),
      ...(d.productKode ? { productKode: String(d.productKode).trim() } : {}),
      ...(d.satuan ? { satuan: String(d.satuan).trim().toUpperCase() } : {}),
    }))
    .filter((d) => d.recipeKode && d.productId);
}

type Line = { productId?: string; productKode?: string; satuan?: string };

/**
 * Hapus baris bahan tertentu dari resep aktif sesuai file keputusan (mis. baris ganda satu kode dengan
 * satuan dapur berbeda yang menahan gabung produk). Lewat revisi resep (CAS) + audit RECIPE_UPDATE.
 * Aman diulang: baris yang sudah hilang dilaporkan NOT_FOUND.
 */
export const removeRecipeLinesMigration: Migration = {
  id: REMOVE_RECIPE_LINES_ID,
  description: 'Hapus baris bahan resep sesuai file keputusan (revisi resep + audit)',
  async run(ctx) {
    const { db, tenantId } = ctx;
    const actor = ctx.actor || 'system';
    const revisionActor = { userId: `migration:${actor}`, userName: `Migrasi (${actor})` };
    const decisions = parseRemoveRecipeLineDecisions(ctx.options?.decisions);
    const results: RemoveRecipeLineResult[] = [];
    let changed = 0;

    for (const d of decisions) {
      const recipe = await db.collection(RECIPES_COLLECTION).findOne(
        { tenantId, kode: d.recipeKode, aktif: { $ne: false } },
        { projection: { _id: 0 }, sort: { version: -1 } },
      ) as RecipeWithState | null;
      if (!recipe) {
        results.push({ ...d, removedLines: 0, result: 'NOT_FOUND', detail: 'Resep aktif tidak ditemukan' });
        continue;
      }
      const lines = (recipe.lines || []) as Line[];
      const targets = lines.filter((l) => l.productId === d.productId);
      if (!targets.length) {
        results.push({ ...d, recipeId: recipe.id, removedLines: 0, result: 'NOT_FOUND', detail: 'Baris bahan tidak ada di resep' });
        continue;
      }
      const mismatch = targets.find((l) => (d.productKode && l.productKode !== d.productKode)
        || (d.satuan && String(l.satuan || '').toUpperCase() !== d.satuan));
      if (mismatch) {
        results.push({
          ...d,
          recipeId: recipe.id,
          removedLines: 0,
          result: 'MISMATCH',
          detail: `Baris di resep: ${mismatch.productKode} ${mismatch.satuan} — tidak cocok dengan keputusan`,
        });
        continue;
      }
      const nextLines = lines.filter((l) => l.productId !== d.productId);
      if (!nextLines.length) {
        results.push({ ...d, recipeId: recipe.id, removedLines: 0, result: 'EMPTY_RECIPE', detail: 'Resep tidak boleh kosong' });
        continue;
      }
      if (ctx.dryRun) {
        results.push({ ...d, recipeId: recipe.id, removedLines: targets.length, result: 'WOULD_REMOVE' });
        continue;
      }
      const res = await updateRecipeWithRevision(db, recipe, { lines: nextLines, updatedAt: ctx.now }, {
        actor: revisionActor,
        now: ctx.now,
        audit: (revisions) => ({
          tenantId,
          action: 'RECIPE_UPDATE',
          entityType: 'recipe',
          entityId: recipe.id,
          summary: `Resep ${recipe.kode}: baris ${d.productKode || d.productId} dihapus (migrasi)`,
          metadata: {
            migration: REMOVE_RECIPE_LINES_ID,
            removed: targets,
            revisions: revisions.map((r) => ({ id: r.id, revision: r.revision, reason: r.reason })),
          },
          ...revisionActor,
        }),
      });
      if (!res.ok) {
        results.push({ ...d, recipeId: recipe.id, removedLines: 0, result: 'CONFLICT', detail: 'Resep berubah bersamaan — jalankan ulang' });
        continue;
      }
      results.push({ ...d, recipeId: recipe.id, removedLines: targets.length, result: 'REMOVED' });
      changed += 1;
    }

    const count = (r: RemoveRecipeLineResult['result']) => results.filter((x) => x.result === r).length;
    const done = ctx.dryRun ? count('WOULD_REMOVE') : count('REMOVED');
    const problems = results.length - done;
    return {
      summary: `${decisions.length} keputusan: ${done} baris resep ${ctx.dryRun ? 'akan dihapus' : 'dihapus'}`
        + (problems ? `; ${problems} tidak diproses (lihat laporan)` : ''),
      before: { decisions },
      after: { results },
      changed,
    };
  },
};
