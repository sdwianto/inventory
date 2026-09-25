/**
 * Revisi resep: snapshot isi resep yang tidak berubah lagi setelah ditulis.
 * MRP dan HPP menyimpan `recipeRevisionId` sehingga angka historis tidak ikut berubah saat resep diedit.
 */

import { createHash } from 'node:crypto';
import type { RecipeDoc, RecipeLine } from '@/lib/food-production/recipe';

export const RECIPE_REVISIONS_COLLECTION = 'recipe_revisions';

export type RecipeRevisionReason = 'CREATE' | 'UPDATE' | 'IMPORT' | 'RECOMPUTE' | 'BACKFILL' | 'PRODUCT_MERGE';

/** Field resep yang menentukan angka (MRP, HPP, gizi) dan identitasnya. */
export type RecipeRevisionContent = Pick<
  RecipeDoc,
  'kode' | 'nama' | 'version' | 'effectiveDate' | 'yieldQty' | 'lines'
> & {
  kategoriMenu: RecipeDoc['kategoriMenu'] | null;
  wastePct: number | null;
  finishedGoodProductId: string | null;
  finishedGoodKode: string | null;
  finishedGoodNama: string | null;
};

export interface RecipeRevisionDoc extends RecipeRevisionContent {
  id: string;
  tenantId: string;
  recipeId: string;
  /** 1, 2, 3, … per resep. */
  revision: number;
  contentHash: string;
  reason: RecipeRevisionReason;
  createdAt: Date;
  createdBy?: string;
  createdByName?: string;
}

/** Revisi resep yang dipakai sebuah dokumen (MRP, hasil HPP). */
export type RecipeRevisionPin = {
  recipeId: string;
  recipeKode?: string;
  revisionId: string;
  revision: number;
};

/** Field pelacak revisi di dokumen `recipes`. */
export type RecipeRevisionState = {
  currentRevisionId?: string;
  revision?: number;
  revisionHash?: string;
};

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  const s = v == null ? '' : String(v).trim();
  return s || null;
}

export function recipeRevisionContent(recipe: Partial<RecipeDoc>): RecipeRevisionContent {
  return {
    kode: String(recipe.kode || ''),
    nama: String(recipe.nama || ''),
    version: Number(recipe.version) || 1,
    effectiveDate: String(recipe.effectiveDate || ''),
    yieldQty: Number(recipe.yieldQty) || 0,
    kategoriMenu: recipe.kategoriMenu ?? null,
    wastePct: numOrNull(recipe.wastePct),
    finishedGoodProductId: strOrNull(recipe.finishedGoodProductId),
    finishedGoodKode: strOrNull(recipe.finishedGoodKode),
    finishedGoodNama: strOrNull(recipe.finishedGoodNama),
    lines: (recipe.lines || []).map((l) => ({ ...l })) as RecipeLine[],
  };
}

/** Field null dan undefined dianggap sama: driver bisa menyimpan undefined sebagai null. */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] != null && k !== '_id').sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function recipeContentHash(content: RecipeRevisionContent): string {
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

/** Resep untuk perhitungan dari revisi (HPP historis). Status aktif tidak relevan untuk angka lampau. */
export function recipeFromRevision(rev: RecipeRevisionDoc, live?: Partial<RecipeDoc> | null): RecipeDoc & RecipeRevisionState {
  return {
    id: rev.recipeId,
    tenantId: rev.tenantId,
    kode: rev.kode,
    nama: rev.nama,
    version: rev.version,
    effectiveDate: rev.effectiveDate,
    yieldQty: rev.yieldQty,
    kategoriMenu: rev.kategoriMenu ?? undefined,
    wastePct: rev.wastePct ?? undefined,
    finishedGoodProductId: rev.finishedGoodProductId ?? undefined,
    finishedGoodKode: rev.finishedGoodKode ?? undefined,
    finishedGoodNama: rev.finishedGoodNama ?? undefined,
    lines: rev.lines,
    aktif: true,
    createdAt: live?.createdAt ?? rev.createdAt,
    updatedAt: rev.createdAt,
    currentRevisionId: rev.id,
    revision: rev.revision,
    revisionHash: rev.contentHash,
  };
}

export function recipeRevisionPin(
  recipe: Pick<RecipeDoc, 'id' | 'kode'> & RecipeRevisionState,
): RecipeRevisionPin | null {
  if (!recipe.currentRevisionId) return null;
  return {
    recipeId: recipe.id,
    recipeKode: recipe.kode,
    revisionId: recipe.currentRevisionId,
    revision: Number(recipe.revision) || 0,
  };
}
