import { v4 as uuidv4 } from 'uuid';
import type { ClientSession, Db } from 'mongodb';
import { txOpts, runInTransactionOnDb } from '@/lib/api/transaction';
import { CasConflictError, insertWithAudit, isCasConflict } from '@/lib/api/cas';
import { writeAuditLog, type AuditLogEntry } from '@/lib/api/audit-log';
import { RECIPES_COLLECTION, type RecipeDoc } from '@/lib/food-production/recipe';
import {
  RECIPE_REVISIONS_COLLECTION,
  recipeRevisionPin,
  recipeContentHash,
  recipeFromRevision,
  recipeRevisionContent,
  type RecipeRevisionDoc,
  type RecipeRevisionPin,
  type RecipeRevisionReason,
  type RecipeRevisionState,
} from '@/lib/food-production/recipe-revision';
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
  type MaterialRequirementDoc,
  type MaterialRequirementLine,
} from '@/lib/food-production/material-requirement';

export type RevisionActor = { userId?: string; userName?: string };

export type RecipeWithState = RecipeDoc & RecipeRevisionState;

export type PreparedRecipeRevision = {
  doc: RecipeRevisionDoc;
  state: Required<RecipeRevisionState>;
};

/**
 * Revisi berikutnya untuk isi resep `next`. `null` bila isi sama dengan revisi terkini
 * (edit gambar/status aktif tidak membuat revisi).
 */
export function prepareRecipeRevision(
  next: RecipeWithState,
  opts: { reason: RecipeRevisionReason; actor?: RevisionActor; now: Date },
): PreparedRecipeRevision | null {
  const content = recipeRevisionContent(next);
  const contentHash = recipeContentHash(content);
  if (next.currentRevisionId && next.revisionHash === contentHash) return null;
  const revision = (Number(next.revision) || 0) + 1;
  const doc: RecipeRevisionDoc = {
    ...content,
    id: uuidv4(),
    tenantId: next.tenantId,
    recipeId: next.id,
    revision,
    contentHash,
    reason: opts.reason,
    createdAt: opts.now,
    createdBy: opts.actor?.userId,
    createdByName: opts.actor?.userName,
  };
  return { doc, state: { currentRevisionId: doc.id, revision, revisionHash: contentHash } };
}

/**
 * Revisi untuk perubahan resep lama → baru. Resep lama tanpa revisi dapat revisi BACKFILL
 * (isi sebelum edit) lebih dulu supaya riwayat tidak kehilangan versi awal.
 */
export function prepareRecipeRevisionsForChange(
  before: RecipeWithState,
  after: RecipeWithState,
  opts: { reason: RecipeRevisionReason; actor?: RevisionActor; now: Date },
): { docs: RecipeRevisionDoc[]; state: Required<RecipeRevisionState> | null } {
  const docs: RecipeRevisionDoc[] = [];
  let base: RecipeRevisionState = {
    currentRevisionId: before.currentRevisionId,
    revision: before.revision,
    revisionHash: before.revisionHash,
  };
  if (!before.currentRevisionId) {
    const backfill = prepareRecipeRevision(before, { ...opts, reason: 'BACKFILL' });
    if (backfill) {
      docs.push(backfill.doc);
      base = backfill.state;
    }
  }
  const next = prepareRecipeRevision({ ...after, ...base }, opts);
  if (next) docs.push(next.doc);
  const state = next?.state ?? (docs.length ? (base as Required<RecipeRevisionState>) : null);
  return { docs, state };
}

/** Resep baru + revisi 1 + audit dalam satu transaksi. `doc` diisi field status revisi. */
export async function insertRecipeWithRevision(
  db: Db,
  doc: RecipeWithState,
  opts: { reason: 'CREATE' | 'IMPORT'; actor?: RevisionActor; audit: AuditLogEntry },
): Promise<void> {
  const prepared = prepareRecipeRevision(doc, { reason: opts.reason, actor: opts.actor, now: doc.createdAt ?? new Date() });
  if (prepared) Object.assign(doc, prepared.state);
  await insertWithAudit({
    db,
    collection: RECIPES_COLLECTION,
    doc,
    before: async ({ db: txDb, session }) => {
      if (prepared) await insertRecipeRevisions(txDb, [prepared.doc], session);
    },
    audit: () => ({
      ...opts.audit,
      metadata: { ...opts.audit.metadata, revision: prepared?.state.revision ?? null },
    }),
  });
}

export type RecipeUpdateResult =
  | { ok: true; revisions: RecipeRevisionDoc[] }
  | { ok: false; conflict: true };

/**
 * Update resep dengan compare-and-set (`updatedAt` + revisi terkini) dan revisi baru bila isi berubah,
 * atomik dengan audit. Konflik (diedit/dipin MRP sejak dibaca) → `conflict`.
 */
export async function updateRecipeWithRevision(
  db: Db,
  existing: RecipeWithState,
  update: Record<string, unknown>,
  opts: {
    reason?: 'UPDATE' | 'RECOMPUTE' | 'PRODUCT_MERGE';
    actor?: RevisionActor;
    now: Date;
    audit: (revisions: RecipeRevisionDoc[]) => AuditLogEntry;
    retried?: boolean;
  },
): Promise<RecipeUpdateResult> {
  let docs: RecipeRevisionDoc[] = [];
  try {
    await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      docs = await updateRecipeWithRevisionInTx(txDb, session, existing, update, opts);
    });
  } catch (e) {
    if (!isCasConflict(e) && !isDuplicateKeyError(e)) throw e;
    // Resep lama baru saja diberi revisi awal oleh MRP (isi & updatedAt tetap): ulangi sekali di atas revisi itu.
    if (!existing.currentRevisionId && !opts.retried) {
      const fresh = await db.collection(RECIPES_COLLECTION).findOne(
        { tenantId: existing.tenantId, id: existing.id },
        { projection: { _id: 0 } },
      ) as RecipeWithState | null;
      if (fresh?.currentRevisionId && sameInstant(fresh.updatedAt, existing.updatedAt)) {
        return updateRecipeWithRevision(db, fresh, update, { ...opts, retried: true });
      }
    }
    return { ok: false, conflict: true };
  }
  return { ok: true, revisions: docs };
}

/**
 * Langkah CAS + revisi + audit di dalam transaksi pemanggil. Resep berubah sejak dibaca → CasConflictError
 * (transaksi pemanggil batal seluruhnya).
 */
export async function updateRecipeWithRevisionInTx(
  txDb: Db,
  session: ClientSession | undefined,
  existing: RecipeWithState,
  update: Record<string, unknown>,
  opts: {
    reason?: 'UPDATE' | 'RECOMPUTE' | 'PRODUCT_MERGE';
    actor?: RevisionActor;
    now: Date;
    audit: (revisions: RecipeRevisionDoc[]) => AuditLogEntry;
  },
): Promise<RecipeRevisionDoc[]> {
  const after = { ...existing, ...update } as RecipeWithState;
  const { docs, state } = prepareRecipeRevisionsForChange(existing, after, {
    reason: opts.reason ?? 'UPDATE', actor: opts.actor, now: opts.now,
  });
  const res = await txDb.collection(RECIPES_COLLECTION).updateOne(
    {
      tenantId: existing.tenantId,
      id: existing.id,
      updatedAt: existing.updatedAt ?? null,
      currentRevisionId: existing.currentRevisionId ?? null,
    },
    { $set: { ...update, ...(state || {}) } },
    txOpts(session),
  );
  if (res.matchedCount === 0) throw new CasConflictError();
  await insertRecipeRevisions(txDb, docs, session);
  await writeAuditLog(txDb, opts.audit(docs), session);
  return docs;
}

function sameInstant(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  return new Date(a as Date).getTime() === new Date(b as Date).getTime();
}

function isDuplicateKeyError(e: unknown): boolean {
  return (e as { code?: number } | null)?.code === 11000;
}

export async function insertRecipeRevisions(
  db: Db,
  docs: RecipeRevisionDoc[],
  session?: ClientSession,
): Promise<void> {
  if (!docs.length) return;
  await db.collection(RECIPE_REVISIONS_COLLECTION).insertMany(docs as never[], txOpts(session));
}

/**
 * Pin revisi untuk isi resep yang sudah dibaca pemanggil. Resep tanpa revisi (sebelum migrasi 0002)
 * dapat revisi BACKFILL dari isi itu. Bila resep sempat diedit sejak dibaca (sudah punya revisi),
 * dipakai revisi yang hash-nya sama dengan isi yang dibaca; tidak ada → tanpa pin.
 */
export async function ensureRecipeRevisions(
  db: Db,
  recipes: RecipeWithState[],
  actor?: RevisionActor,
): Promise<Map<string, RecipeRevisionPin>> {
  const out = new Map<string, RecipeRevisionPin>();
  for (const recipe of recipes) {
    if (!recipe?.id || out.has(recipe.id)) continue;
    const pin = recipeRevisionPin(recipe);
    if (pin) {
      out.set(recipe.id, pin);
      continue;
    }
    const prepared = prepareRecipeRevision(recipe, { reason: 'BACKFILL', actor, now: new Date() });
    if (!prepared) continue;
    const applied = await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const res = await txDb.collection(RECIPES_COLLECTION).updateOne(
        { tenantId: recipe.tenantId, id: recipe.id, currentRevisionId: { $exists: false } },
        { $set: prepared.state },
        txOpts(session),
      );
      if (res.matchedCount === 0) return false;
      await insertRecipeRevisions(txDb, [prepared.doc], session);
      return true;
    });
    if (applied) {
      out.set(recipe.id, {
        recipeId: recipe.id, recipeKode: recipe.kode, revisionId: prepared.state.currentRevisionId, revision: prepared.state.revision,
      });
      continue;
    }
    const same = await db.collection(RECIPE_REVISIONS_COLLECTION).findOne(
      { tenantId: recipe.tenantId, recipeId: recipe.id, contentHash: prepared.doc.contentHash },
      { sort: { revision: -1 }, projection: { id: 1, revision: 1 } },
    ) as Pick<RecipeRevisionDoc, 'id' | 'revision'> | null;
    if (same) {
      out.set(recipe.id, { recipeId: recipe.id, recipeKode: recipe.kode, revisionId: same.id, revision: same.revision });
    }
  }
  return out;
}

/**
 * Pin revisi untuk dokumen MRP yang akan ditulis, dari isi resep mentah yang dipakai explode
 * (sebelum rebase/pengayaan), lalu cap `recipeRevisionId` di setiap sumber baris.
 */
export async function finalizeMrpRecipeRevisions(
  db: Db,
  built: { lines?: MaterialRequirementLine[]; revisionSources?: RecipeWithState[] },
  actor?: RevisionActor,
): Promise<{ lines: MaterialRequirementLine[]; recipeRevisions: RecipeRevisionPin[] }> {
  const pins = await ensureRecipeRevisions(db, built.revisionSources || [], actor);
  const lines = (built.lines || []).map((l) => ({
    ...l,
    sources: (l.sources || []).map((s) => ({
      ...s,
      recipeRevisionId: pins.get(s.recipeId)?.revisionId ?? null,
    })),
  }));
  return { lines, recipeRevisions: [...pins.values()] };
}

export async function loadRecipeRevisionsByIds(
  db: Db,
  tenantId: string,
  ids: string[],
): Promise<Map<string, RecipeRevisionDoc>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const docs = await db.collection(RECIPE_REVISIONS_COLLECTION)
    .find({ tenantId, id: { $in: unique } })
    .project({ _id: 0 })
    .toArray() as unknown as RecipeRevisionDoc[];
  return new Map(docs.map((d) => [d.id, d]));
}

export type PlanRecipeSource = 'MRP' | 'LIVE' | 'MIXED';

export type PinnedPlanRecipes = {
  mrpNo: string;
  pinsBackfilled?: boolean;
  /** recipeId → resep dari revisi yang dipin. */
  recipes: Map<string, RecipeDoc>;
  pins: Map<string, RecipeRevisionPin>;
};

/**
 * Revisi resep yang dipin MRP terbaru (belum Dibatalkan) per rencana. Rencana yang MRP terbarunya
 * belum berpin (data sebelum 2.2 tanpa migrasi 0002) tidak ada di hasil → pemanggil memakai resep terkini.
 */
export async function loadPinnedPlanRecipes(
  db: Db,
  tenantId: string,
  planIds: string[],
): Promise<Map<string, PinnedPlanRecipes>> {
  const out = new Map<string, PinnedPlanRecipes>();
  const ids = [...new Set(planIds.filter(Boolean))];
  if (!ids.length) return out;
  const mrps = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION)
    .find(
      { tenantId, productionPlanId: { $in: ids }, status: { $nin: ['CANCELLED'] } },
      { projection: { _id: 0, productionPlanId: 1, noDokumen: 1, recipeRevisions: 1, recipeRevisionsBackfilled: 1, createdAt: 1 } },
    )
    .sort({ createdAt: -1 })
    .toArray() as unknown as Array<Pick<MaterialRequirementDoc, 'productionPlanId' | 'noDokumen' | 'recipeRevisions' | 'recipeRevisionsBackfilled'>>;
  const latest = new Map<string, (typeof mrps)[number]>();
  for (const m of mrps) if (!latest.has(m.productionPlanId)) latest.set(m.productionPlanId, m);

  const revisions = await loadRecipeRevisionsByIds(
    db,
    tenantId,
    [...latest.values()].flatMap((m) => (m.recipeRevisions || []).map((p) => p.revisionId)),
  );
  for (const [planId, mrp] of latest) {
    if (!mrp.recipeRevisions?.length) continue;
    const recipes = new Map<string, RecipeDoc>();
    const pins = new Map<string, RecipeRevisionPin>();
    for (const pin of mrp.recipeRevisions) {
      const rev = revisions.get(pin.revisionId);
      if (!rev) continue;
      recipes.set(pin.recipeId, recipeFromRevision(rev));
      pins.set(pin.recipeId, pin);
    }
    out.set(planId, {
      mrpNo: mrp.noDokumen,
      pinsBackfilled: mrp.recipeRevisionsBackfilled === true || undefined,
      recipes,
      pins,
    });
  }
  return out;
}

/** Resep terkini ditimpa revisi yang dipin rencana; `source` menjelaskan asal angka. */
export function mergePlanRecipes(
  recipeIds: string[],
  liveById: Map<string, RecipeDoc>,
  pinned: PinnedPlanRecipes | undefined,
): { recipesById: Map<string, RecipeDoc>; source: PlanRecipeSource; pins: RecipeRevisionPin[] } {
  const ids = [...new Set(recipeIds.filter(Boolean))];
  const recipesById = new Map<string, RecipeDoc>();
  const pins: RecipeRevisionPin[] = [];
  for (const id of ids) {
    const fromRev = pinned?.recipes.get(id);
    if (fromRev) {
      recipesById.set(id, fromRev);
      pins.push(pinned!.pins.get(id)!);
      continue;
    }
    const live = liveById.get(id);
    if (live) recipesById.set(id, live);
  }
  const source: PlanRecipeSource = !pins.length ? 'LIVE' : pins.length === ids.length ? 'MRP' : 'MIXED';
  return { recipesById, source, pins };
}

/**
 * Resep untuk HPP rencana: revisi yang dipin MRP rencana (angka historis tetap),
 * selain itu resep terkini (rencana belum punya MRP / resep di luar MRP).
 */
export async function loadPlanRecipesForCost(
  db: Db,
  tenantId: string,
  planId: string,
  recipeIds: string[],
): Promise<{
  recipes: RecipeDoc[];
  source: PlanRecipeSource;
  pins: RecipeRevisionPin[];
  mrpNo?: string;
  pinsBackfilled?: boolean;
}> {
  const ids = [...new Set(recipeIds.filter(Boolean))];
  const [pinnedByPlan, live] = await Promise.all([
    loadPinnedPlanRecipes(db, tenantId, [planId]),
    ids.length
      ? db.collection(RECIPES_COLLECTION).find({ tenantId, id: { $in: ids } }).toArray() as unknown as Promise<RecipeDoc[]>
      : Promise.resolve([] as RecipeDoc[]),
  ]);
  const pinned = pinnedByPlan.get(planId);
  const merged = mergePlanRecipes(ids, new Map(live.map((r) => [r.id, r])), pinned);
  return {
    recipes: [...merged.recipesById.values()],
    source: merged.source,
    pins: merged.pins,
    mrpNo: pinned?.mrpNo,
    pinsBackfilled: pinned?.pinsBackfilled,
  };
}
