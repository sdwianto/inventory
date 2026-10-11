import { describe, expect, it } from 'vitest';
import { planRecipientPorsi } from '@/lib/food-production/production-plan';
import type { PortionTargetMap } from '@/lib/food-production/portion-target';
import { hidanganInputFromWeeklyDay } from '@/lib/food-production/kebutuhan-bahan-harian';
import {
  applyMenuPackageToDay,
  buildPublishPlanLines,
  copyWeekDays,
  draftNutritionLinesFromDay,
  normalizeWeeklyDays,
  slotPorsiCoverageWarnings,
  slotRecipePorsi,
  weeklyDayContentEqual,
  type WeeklyMenuDay,
  type WeeklyRecipeRef,
} from '@/lib/food-production/weekly-menu-plan';

const WEEK_START = '2026-10-12';
const RABU = '2026-10-14';

const PORSI: PortionTargetMap = {
  PORSI_KECIL: 400,
  PORSI_BESAR: 800,
  POSYANDU_BALITA: 50,
  POSYANDU_BUMIL: 30,
  POSYANDU_BUSUI: 20,
  ORGANOLEPTIK: 12,
};
const PB_TOTAL = 800 + 30 + 20 + 12;
const PK_TOTAL = 400 + 50;
const ALL = PB_TOTAL + PK_TOTAL;

function recipe(id: string, kategoriMenu: string): WeeklyRecipeRef {
  return { id, kode: id.toUpperCase(), nama: id, aktif: true, kategoriMenu, lines: [{ productId: 'p' }] };
}

const recipes = new Map<string, WeeklyRecipeRef>([
  ['nasi', recipe('nasi', 'KARBOHIDRAT')],
  ['beef-pb', recipe('beef-pb', 'LAUK_HEWANI')],
  ['beef-pk', recipe('beef-pk', 'LAUK_HEWANI')],
]);

function day(extra?: Partial<WeeklyMenuDay>): WeeklyMenuDay {
  return {
    tanggal: RABU,
    porsiByKategori: { ...PORSI },
    slots: { KARBOHIDRAT: ['nasi'], LAUK_HEWANI: ['beef-pb', 'beef-pk'] },
    alergi: [],
    ...extra,
  };
}

const SPLIT = { 'beef-pb': ['BESAR' as const], 'beef-pk': ['KECIL' as const] };

describe('menu slot porsi family (PB/PK split)', () => {
  it('defaults to the full PM total for every recipe', () => {
    const d = day();
    expect(slotRecipePorsi(d, 'beef-pb').targetPorsi).toBe(ALL);
    expect(slotRecipePorsi(d, 'beef-pk').targetPorsi).toBe(ALL);
    expect(slotRecipePorsi(d, 'nasi').targetPorsi).toBe(ALL);
  });

  it('splits a multi-recipe category by family', () => {
    const d = day({ recipePorsiFamilies: SPLIT });
    expect(slotRecipePorsi(d, 'beef-pb')).toEqual({
      kategoriPorsiList: ['PORSI_BESAR', 'POSYANDU_BUMIL', 'POSYANDU_BUSUI', 'ORGANOLEPTIK'],
      targetPorsi: PB_TOTAL,
      split: true,
    });
    expect(slotRecipePorsi(d, 'beef-pk')).toEqual({
      kategoriPorsiList: ['PORSI_KECIL', 'POSYANDU_BALITA'],
      targetPorsi: PK_TOTAL,
      split: true,
    });
  });

  it('skips a recipe whose only family has 0 porsi instead of falling back to the full total', () => {
    const noPk = { ...PORSI, PORSI_KECIL: 0, POSYANDU_BALITA: 0 };
    const d = day({ porsiByKategori: noPk, recipePorsiFamilies: SPLIT });
    const built = buildPublishPlanLines(d, recipes);
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    expect(built.lines.map((l) => l.recipeId)).not.toContain('beef-pk');
    expect(built.lines.find((l) => l.recipeId === 'beef-pb')!.targetPorsi).toBe(PB_TOTAL);
    expect(built.warnings.some((w) => /BEEF-PK \(PK\) 0 porsi/.test(w))).toBe(true);
    expect(hidanganInputFromWeeklyDay(d, recipes).map((h) => h.recipeId)).not.toContain('beef-pk');
    expect(draftNutritionLinesFromDay(d).map((l) => l.recipeId)).not.toContain('beef-pk');
  });

  it('ignores a family choice on a single-recipe category', () => {
    const d = day({ recipePorsiFamilies: { nasi: ['KECIL'] } });
    expect(slotRecipePorsi(d, 'nasi').targetPorsi).toBe(ALL);
  });

  it('normalizes: drops both-family and stray entries, rejects empty', () => {
    const base = day();
    const ok = normalizeWeeklyDays([{
      ...base,
      recipePorsiFamilies: { 'beef-pb': ['BESAR'], 'beef-pk': ['BESAR', 'KECIL'], nasi: ['KECIL'], ghost: ['KECIL'] },
    }], WEEK_START);
    expect('error' in ok).toBe(false);
    const rabu = (ok as WeeklyMenuDay[]).find((d) => d.tanggal === RABU)!;
    expect(rabu.recipePorsiFamilies).toEqual({ 'beef-pb': ['BESAR'] });

    const none = normalizeWeeklyDays([{ ...base, recipePorsiFamilies: {} }], WEEK_START) as WeeklyMenuDay[];
    expect(none.find((d) => d.tanggal === RABU)!.recipePorsiFamilies).toBeUndefined();

    expect(normalizeWeeklyDays([{ ...base, recipePorsiFamilies: { 'beef-pb': [] } }], WEEK_START))
      .toEqual({ error: expect.stringMatching(/minimal PB atau PK/) });
  });

  it('keeps previous families when the field is omitted', () => {
    const prev = normalizeWeeklyDays([day({ recipePorsiFamilies: SPLIT })], WEEK_START) as WeeklyMenuDay[];
    const { recipePorsiFamilies: _omit, ...rest } = day();
    const next = normalizeWeeklyDays([rest], WEEK_START, prev) as WeeklyMenuDay[];
    expect(next.find((d) => d.tanggal === RABU)!.recipePorsiFamilies).toEqual(SPLIT);
  });

  it('warns when a family has no recipe in a multi-recipe category', () => {
    expect(slotPorsiCoverageWarnings(day({ recipePorsiFamilies: SPLIT }))).toEqual([]);
    const gap = slotPorsiCoverageWarnings(day({ recipePorsiFamilies: { 'beef-pb': ['BESAR'], 'beef-pk': ['BESAR'] } }));
    expect(gap).toEqual([`${RABU}: Lauk Hewani — PK (${PK_TOTAL}) tidak ada resep`]);
  });

  it('publish lines carry the split and the coverage warning; recipient count stays the PM total', () => {
    const built = buildPublishPlanLines(day({ recipePorsiFamilies: SPLIT }), recipes);
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    const byId = new Map(built.lines.map((l) => [l.recipeId, l]));
    expect(byId.get('nasi')!.targetPorsi).toBe(ALL);
    expect(byId.get('beef-pb')!.targetPorsi).toBe(PB_TOTAL);
    expect(byId.get('beef-pk')!.targetPorsi).toBe(PK_TOTAL);
    expect(planRecipientPorsi(built.lines)).toBe(ALL);
    expect(ALL).toBe(1312);

    const gap = buildPublishPlanLines(day({ recipePorsiFamilies: { 'beef-pb': ['BESAR'], 'beef-pk': ['BESAR'] } }), recipes);
    expect('error' in gap).toBe(false);
    if (!('error' in gap)) expect(gap.warnings.some((w) => /PK .* tidak ada resep/.test(w))).toBe(true);
  });

  it('Hidangan and draft gizi lines follow the split', () => {
    const d = day({ recipePorsiFamilies: SPLIT });
    const hid = hidanganInputFromWeeklyDay(d, recipes);
    expect(hid.find((h) => h.recipeId === 'beef-pk')!.targetPorsi).toBe(PK_TOTAL);
    expect(hid.find((h) => h.recipeId === 'nasi')!.targetPorsi).toBe(ALL);
    const draft = draftNutritionLinesFromDay(d);
    expect(draft.find((l) => l.recipeId === 'beef-pb')!.kategoriPorsiList).not.toContain('PORSI_KECIL');
  });

  it('a family change alters the content key (edit lock / republish)', () => {
    expect(weeklyDayContentEqual(day(), day({ recipePorsiFamilies: SPLIT }))).toBe(false);
    expect(weeklyDayContentEqual(day({ recipePorsiFamilies: SPLIT }), day({ recipePorsiFamilies: { ...SPLIT } }))).toBe(true);
  });

  it('copy keeps families; applying a package resets them', () => {
    const src = day({ recipePorsiFamilies: SPLIT });
    const dst = day({ tanggal: '2026-10-21', slots: {}, recipePorsiFamilies: undefined });
    const [copied] = copyWeekDays([src], [dst]);
    expect(copied.recipePorsiFamilies).toEqual(SPLIT);
    const applied = applyMenuPackageToDay(src, [{ recipeId: 'beef-pb' }, { recipeId: 'nasi' }], recipes);
    expect('error' in applied).toBe(false);
    if (!('error' in applied)) expect(applied.recipePorsiFamilies).toEqual({});
  });
});
