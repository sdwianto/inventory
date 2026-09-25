import { describe, expect, it } from 'vitest';
import {
  recipeContentHash,
  recipeFromRevision,
  recipeRevisionContent,
  recipeRevisionPin,
} from '@/lib/food-production/recipe-revision';
import { prepareRecipeRevision, prepareRecipeRevisionsForChange } from '@/lib/api/recipe-revisions';
import type { RecipeDoc } from '@/lib/food-production/recipe';

const NOW = new Date('2026-09-25T00:00:00Z');

function recipe(extra: Partial<RecipeDoc> & Record<string, unknown> = {}): RecipeDoc & Record<string, unknown> {
  return {
    id: 'r1',
    tenantId: 't1',
    kode: 'RSP-0001',
    nama: 'Tumis Tahu',
    version: 1,
    effectiveDate: '2026-09-01',
    yieldQty: 100,
    kategoriMenu: 'LAUK_NABATI',
    lines: [{ productId: 'p1', qty: 50, qtyBesar: 50, pctKecil: 100, satuan: 'GR', qtyBaseBesar: 0.05 }],
    aktif: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  } as RecipeDoc & Record<string, unknown>;
}

describe('recipeContentHash', () => {
  it('stabil terhadap urutan key, null vs undefined, dan _id', () => {
    const a = recipeRevisionContent(recipe());
    const b = recipeRevisionContent(recipe({
      lines: [{ satuan: 'GR', qtyBaseBesar: 0.05, pctKecil: 100, qtyBesar: 50, qty: 50, productId: 'p1', notes: undefined, _id: 'x' } as never],
      wastePct: undefined,
    }));
    const c = recipeRevisionContent(recipe({
      lines: [{ productId: 'p1', qty: 50, qtyBesar: 50, pctKecil: 100, satuan: 'GR', qtyBaseBesar: 0.05, notes: null } as never],
      wastePct: null as never,
    }));
    expect(recipeContentHash(b)).toBe(recipeContentHash(a));
    expect(recipeContentHash(c)).toBe(recipeContentHash(a));
  });

  it('berubah bila angka, bahan, atau identitas resep berubah', () => {
    const base = recipeContentHash(recipeRevisionContent(recipe()));
    expect(recipeContentHash(recipeRevisionContent(recipe({ yieldQty: 200 })))).not.toBe(base);
    expect(recipeContentHash(recipeRevisionContent(recipe({ nama: 'Tumis Tempe' })))).not.toBe(base);
    expect(recipeContentHash(recipeRevisionContent(recipe({
      lines: [{ productId: 'p1', qty: 60, qtyBesar: 60, pctKecil: 100, satuan: 'GR', qtyBaseBesar: 0.06 }],
    })))).not.toBe(base);
  });

  it('tidak dipengaruhi field non-isi (gambar, aktif, catatan, updatedAt)', () => {
    const base = recipeContentHash(recipeRevisionContent(recipe()));
    const other = recipeContentHash(recipeRevisionContent(recipe({
      aktif: false, gambarUrl: '/x.jpg', catatan: 'baru', updatedAt: new Date(),
    })));
    expect(other).toBe(base);
  });
});

describe('prepareRecipeRevision', () => {
  it('revisi 1 untuk resep baru, lalu null bila isi tidak berubah', () => {
    const first = prepareRecipeRevision(recipe(), { reason: 'CREATE', now: NOW, actor: { userId: 'u', userName: 'U' } });
    expect(first?.doc).toMatchObject({ recipeId: 'r1', tenantId: 't1', revision: 1, reason: 'CREATE', createdByName: 'U' });
    expect(first?.state.revision).toBe(1);
    const same = prepareRecipeRevision({ ...recipe({ aktif: false }), ...first!.state }, { reason: 'UPDATE', now: NOW });
    expect(same).toBeNull();
    const next = prepareRecipeRevision({ ...recipe({ yieldQty: 120 }), ...first!.state }, { reason: 'UPDATE', now: NOW });
    expect(next?.doc.revision).toBe(2);
  });
});

describe('prepareRecipeRevisionsForChange', () => {
  it('resep lama tanpa revisi: BACKFILL isi lama lalu UPDATE isi baru', () => {
    const before = recipe();
    const after = recipe({ yieldQty: 150 });
    const { docs, state } = prepareRecipeRevisionsForChange(before, after, { reason: 'UPDATE', now: NOW });
    expect(docs.map((d) => [d.revision, d.reason, d.yieldQty])).toEqual([[1, 'BACKFILL', 100], [2, 'UPDATE', 150]]);
    expect(state).toMatchObject({ revision: 2, currentRevisionId: docs[1].id });
  });

  it('resep lama tanpa perubahan isi: hanya BACKFILL', () => {
    const { docs, state } = prepareRecipeRevisionsForChange(recipe(), recipe({ aktif: false }), { reason: 'UPDATE', now: NOW });
    expect(docs.map((d) => d.reason)).toEqual(['BACKFILL']);
    expect(state?.revision).toBe(1);
  });

  it('resep berrevisi tanpa perubahan isi: tidak ada revisi dan state tidak diubah', () => {
    const first = prepareRecipeRevision(recipe(), { reason: 'CREATE', now: NOW })!;
    const cur = { ...recipe(), ...first.state };
    const { docs, state } = prepareRecipeRevisionsForChange(cur, { ...cur, catatan: 'x' }, { reason: 'UPDATE', now: NOW });
    expect(docs).toEqual([]);
    expect(state).toBeNull();
  });
});

describe('recipeFromRevision / recipeRevisionPin', () => {
  it('membangun resep dari revisi (untuk HPP) dan pin dari status revisi', () => {
    const prepared = prepareRecipeRevision(recipe(), { reason: 'CREATE', now: NOW })!;
    const r = recipeFromRevision(prepared.doc);
    expect(r).toMatchObject({ id: 'r1', yieldQty: 100, revision: 1, currentRevisionId: prepared.doc.id, aktif: true });
    expect(r.lines).toEqual(prepared.doc.lines);
    expect(recipeRevisionPin({ id: 'r1', kode: 'K', ...prepared.state })).toEqual({
      recipeId: 'r1', recipeKode: 'K', revisionId: prepared.doc.id, revision: 1,
    });
    expect(recipeRevisionPin({ id: 'r1', kode: 'K' })).toBeNull();
  });
});
