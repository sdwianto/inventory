import { describe, expect, it } from 'vitest';
import { RECIPE_NEED_BUFFER_PCT } from '@/lib/food-production/production-plan';
import { emptyPortionTargets, sumAllPorsi } from '@/lib/food-production/portion-target';
import {
  applyMenuPackageToDay,
  assertDayReadyToPublish,
  assertWeekStart,
  alergiKategoriPorsi,
  akgKeyForDay,
  buildPublishPlanLines,
  copyPorsiOntoDays,
  copyPorsiToDays,
  copyWeekDays,
  clearWeeklyMenuDayContent,
  dayHasMenuContent,
  draftNutritionLinesFromDay,
  emptyWeeklyDays,
  formatCopyPorsiDayLabel,
  formatWeekRangeId,
  groupDatesByWeekStart,
  indexWeeklyRpnByTanggal,
  isoWeekdays,
  localIsoDate,
  lockedDayEditError,
  normalizeSlots,
  normalizeWeeklyDay,
  normalizeWeeklyDays,
  presentWeeklyMenuDays,
  relativeWeekLabel,
  rpnPublishBlockedReason,
  selectPublishTargetPlan,
  slotRecipeIds,
  sumServicePointPorsi,
  weekDelta,
  weekStartFrom,
  weekWindow,
  weeklyDayContentEqual,
  weeklyPlanStatusFromDays,
  type WeeklyRecipeRef,
} from '@/lib/food-production/weekly-menu-plan';

const WEEK_START = '2026-09-21';

function recipe(id: string, kategoriMenu: string, extra?: Partial<WeeklyRecipeRef>): WeeklyRecipeRef {
  return {
    id,
    kode: id.toUpperCase(),
    nama: id,
    aktif: true,
    kategoriMenu,
    lines: [{ productId: 'p' }],
    ...extra,
  };
}

describe('weekly menu plan — weekStart & days', () => {
  it('snaps any weekday to Monday and rejects non-Monday weekStart', () => {
    expect(weekStartFrom('2026-09-23')).toBe(WEEK_START);
    expect(weekStartFrom('2026-09-21')).toBe(WEEK_START);
    expect(weekStartFrom('2026-09-27')).toBe(WEEK_START);
    expect(assertWeekStart(WEEK_START)).toBe(WEEK_START);
    expect(assertWeekStart('2026-09-22')).toEqual({
      error: expect.stringMatching(/senin/i),
    });
    expect(isoWeekdays(WEEK_START)).toEqual([
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
    ]);
  });

  it('labels a 5-week window relative to this week', () => {
    const today = '2026-09-14';
    expect(relativeWeekLabel('2026-09-14', today)).toBe('Minggu ini');
    expect(relativeWeekLabel('2026-09-07', today)).toBe('Minggu lalu');
    expect(relativeWeekLabel('2026-09-21', today)).toBe('Minggu depan');
    expect(relativeWeekLabel('2026-09-28', today)).toBe('2 minggu ke depan');
    expect(relativeWeekLabel('2026-08-31', today)).toBe('2 minggu lalu');
    expect(relativeWeekLabel('2026-10-12', today)).toBe('4 minggu ke depan');
    expect(weekDelta('2026-09-21', today)).toBe(1);
    expect(weekWindow(today, 2)).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
    ]);
    expect(formatWeekRangeId('2026-09-14')).toBe('Sen 14 – Jum 18 Sep 2026');
    expect(formatWeekRangeId('2026-09-28')).toBe('Sen 28 Sep – Jum 2 Okt 2026');
    expect(formatWeekRangeId('2026-12-28')).toBe('Sen 28 Des 2026 – Jum 1 Jan 2027');
    expect(weekWindow('2026-09-16', 2)[2]).toBe('2026-09-14');
    expect(formatCopyPorsiDayLabel('2026-09-22')).toBe('Selasa 22 Sep');
    expect(localIsoDate(new Date('2026-09-17T17:30:00.000Z'))).toBe('2026-09-18');
    expect(localIsoDate(new Date('2026-09-17T16:59:00.000Z'))).toBe('2026-09-17');
    expect([...groupDatesByWeekStart(['2026-09-15', '2026-09-22']).keys()]).toEqual([
      '2026-09-14',
      '2026-09-21',
    ]);
    expect(weekStartFrom('2026-09-19')).toBe('2026-09-14');
    expect(weekStartFrom('2026-09-20')).toBe('2026-09-14');
  });

  it('normalizes five weekdays and keeps publish links from previous days', () => {
    const days = normalizeWeeklyDays(
      [{
        tanggal: '2026-09-22',
        porsiByKategori: { PORSI_KECIL: 10, PORSI_BESAR: 20 },
        slots: { KARBOHIDRAT: ['nasi'] },
        note: 'Selasa',
      }],
      WEEK_START,
      [{
        tanggal: '2026-09-22',
        porsiByKategori: { PORSI_KECIL: 0, PORSI_BESAR: 0, POSYANDU_BALITA: 0, POSYANDU_BUMIL: 0, POSYANDU_BUSUI: 0, ORGANOLEPTIK: 0 },
        slots: {},
        alergi: [],
        productionPlanId: 'rpn-sel',
        productionPlanNo: 'RPN-1',
      }],
    );
    expect(Array.isArray(days)).toBe(true);
    if (!Array.isArray(days)) return;
    expect(days).toHaveLength(5);
    expect(days[1].tanggal).toBe('2026-09-22');
    expect(days[1].slots.KARBOHIDRAT).toEqual(['nasi']);
    expect(days[1].productionPlanId).toBe('rpn-sel');
    expect(days[1].productionPlanNo).toBe('RPN-1');
    expect(days[1].note).toBe('Selasa');
  });
});

describe('weekly menu plan — slots & publish lines', () => {
  it('rejects unknown menu category and duplicate recipe in one slot', () => {
    expect(normalizeSlots({ BUKAN: ['x'] })).toEqual({
      error: expect.stringMatching(/tidak valid/i),
    });
    expect(normalizeSlots({ KARBOHIDRAT: ['nasi', 'nasi'] })).toEqual({
      error: expect.stringMatching(/duplikat/i),
    });
  });

  it('builds RPN lines from slots at full PM; alergi is extra and does not reduce PM', () => {
    const porsiByKategori = {
      PORSI_KECIL: 1058,
      PORSI_BESAR: 1129,
      POSYANDU_BALITA: 331,
      POSYANDU_BUMIL: 27,
      POSYANDU_BUSUI: 76,
      ORGANOLEPTIK: 13,
    };
    const recipes = new Map<string, WeeklyRecipeRef>([
      ['nasi', recipe('nasi', 'KARBOHIDRAT')],
      ['ayam', recipe('ayam', 'LAUK_HEWANI')],
      ['tahu', recipe('tahu', 'LAUK_NABATI')],
    ]);
    const built = buildPublishPlanLines({
      tanggal: WEEK_START,
      porsiByKategori,
      slots: { KARBOHIDRAT: ['nasi'], LAUK_HEWANI: ['ayam'] },
      alergi: [{ recipeId: 'tahu', porsi: 4, catatan: 'kacang' }],
    }, recipes);
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    expect(built.total).toBe(2634);
    expect(built.lines).toHaveLength(3);
    expect(built.lines[0]).toMatchObject({
      recipeId: 'nasi',
      targetPorsi: 2634,
      kategoriPorsiList: [
        'PORSI_KECIL',
        'PORSI_BESAR',
        'POSYANDU_BALITA',
        'POSYANDU_BUMIL',
        'POSYANDU_BUSUI',
        'ORGANOLEPTIK',
      ],
    });
    expect(built.lines[2]).toMatchObject({
      recipeId: 'tahu',
      targetPorsi: 4,
      kategoriPorsiList: ['ORGANOLEPTIK'],
      notes: 'ALERGI: kacang',
    });
    expect(built.recipeBufferPct).toEqual({
      nasi: RECIPE_NEED_BUFFER_PCT,
      ayam: RECIPE_NEED_BUFFER_PCT,
      tahu: RECIPE_NEED_BUFFER_PCT,
    });
    expect(RECIPE_NEED_BUFFER_PCT).toBe(3);
  });

  it('maps alergi to PORSI_BESAR when organoleptik is 0', () => {
    expect(alergiKategoriPorsi({
      PORSI_KECIL: 0,
      PORSI_BESAR: 10,
      POSYANDU_BALITA: 0,
      POSYANDU_BUMIL: 0,
      POSYANDU_BUSUI: 0,
      ORGANOLEPTIK: 0,
    })).toBe('PORSI_BESAR');
  });

  it('rejects slot/alergi same recipe and empty PM', () => {
    expect(assertDayReadyToPublish({
      tanggal: WEEK_START,
      porsiByKategori: {
        PORSI_KECIL: 10,
        PORSI_BESAR: 0,
        POSYANDU_BALITA: 0,
        POSYANDU_BUMIL: 0,
        POSYANDU_BUSUI: 0,
        ORGANOLEPTIK: 0,
      },
      slots: { KARBOHIDRAT: ['nasi'] },
      alergi: [{ recipeId: 'nasi', porsi: 2 }],
    })).toEqual({ error: expect.stringMatching(/tidak boleh sama/i) });

    expect(assertDayReadyToPublish({
      tanggal: WEEK_START,
      porsiByKategori: {
        PORSI_KECIL: 0,
        PORSI_BESAR: 0,
        POSYANDU_BALITA: 0,
        POSYANDU_BUMIL: 0,
        POSYANDU_BUSUI: 0,
        ORGANOLEPTIK: 0,
      },
      slots: { KARBOHIDRAT: ['nasi'] },
      alergi: [],
    })).toEqual({ error: expect.stringMatching(/penerima manfaat/i) });
  });

  it('rejects recipe in the wrong slot; allows missing kategoriMenu with warning', () => {
    const recipes = new Map<string, WeeklyRecipeRef>([
      ['nasi', recipe('nasi', 'SAYUR')],
    ]);
    expect(buildPublishPlanLines({
      tanggal: WEEK_START,
      porsiByKategori: {
        PORSI_KECIL: 10,
        PORSI_BESAR: 0,
        POSYANDU_BALITA: 0,
        POSYANDU_BUMIL: 0,
        POSYANDU_BUSUI: 0,
        ORGANOLEPTIK: 0,
      },
      slots: { KARBOHIDRAT: ['nasi'] },
      alergi: [],
    }, recipes)).toEqual({ error: expect.stringMatching(/bukan slot/i) });

    const legacy = new Map<string, WeeklyRecipeRef>([
      ['lama', recipe('lama', '', { kategoriMenu: null })],
    ]);
    const ok = buildPublishPlanLines({
      tanggal: WEEK_START,
      porsiByKategori: {
        PORSI_KECIL: 10,
        PORSI_BESAR: 0,
        POSYANDU_BALITA: 0,
        POSYANDU_BUMIL: 0,
        POSYANDU_BUSUI: 0,
        ORGANOLEPTIK: 0,
      },
      slots: { KARBOHIDRAT: ['lama'] },
      alergi: [],
    }, legacy);
    expect('error' in ok).toBe(false);
    if ('error' in ok) return;
    expect(ok.warnings.some((w) => /kategori menu/i.test(w))).toBe(true);
  });

  it('blocks overwrite of locked RPN and allows DRAFT republish', () => {
    expect(rpnPublishBlockedReason('APPROVED')).toMatch(/terkunci/i);
    expect(rpnPublishBlockedReason('PROCESSING')).toMatch(/terkunci/i);
    expect(rpnPublishBlockedReason('COMPLETED')).toMatch(/terkunci/i);
    expect(rpnPublishBlockedReason('DRAFT')).toBeNull();
    expect(rpnPublishBlockedReason('SUBMITTED')).toBeNull();
    expect(rpnPublishBlockedReason('CANCELLED')).toBeNull();
  });

  it('absorbs ad-hoc DRAFT on publish and blocks APPROVED same-day RPN', () => {
    const weeklyId = 'w1';
    const adhocDraft = { status: 'DRAFT', noDokumen: 'RPN-A', weeklyMenuPlanId: null };
    const adhocApproved = { status: 'APPROVED', noDokumen: 'RPN-B', weeklyMenuPlanId: null };
    const linkedDraft = { status: 'DRAFT', noDokumen: 'RPN-L', weeklyMenuPlanId: weeklyId };

    expect(selectPublishTargetPlan([adhocDraft], weeklyId)).toEqual({ plan: adhocDraft });
    expect(selectPublishTargetPlan([adhocApproved], weeklyId)).toMatchObject({
      error: expect.stringMatching(/RPN-B/),
    });
    expect(selectPublishTargetPlan([linkedDraft, adhocDraft], weeklyId)).toEqual({ plan: linkedDraft });
    expect(selectPublishTargetPlan([{ status: 'CANCELLED', noDokumen: 'RPN-X', weeklyMenuPlanId: weeklyId }], weeklyId))
      .toEqual({ plan: null });
  });

  it('copies porsi to other days without touching slots', () => {
    const days = emptyWeeklyDays(WEEK_START);
    days[0].porsiByKategori.PORSI_KECIL = 50;
    days[0].slots = { KARBOHIDRAT: ['nasi'] };
    const copied = copyPorsiToDays(days, WEEK_START, ['2026-09-22', '2026-09-23']);
    expect(copied[1].porsiByKategori.PORSI_KECIL).toBe(50);
    expect(copied[1].slots).toEqual({});
    expect(slotRecipeIds(copied[0].slots)).toEqual(['nasi']);
    expect(weeklyPlanStatusFromDays(copied)).toBe('DRAFT');
    copied[0].productionPlanId = 'rpn';
    expect(weeklyPlanStatusFromDays(copied)).toBe('PUBLISHED');

    copied[1].porsiByKategori.PORSI_KECIL = 1;
    const skipped = copyPorsiToDays(copied, WEEK_START, ['2026-09-22', '2026-09-23'], ['2026-09-22']);
    expect(skipped[1].porsiByKategori.PORSI_KECIL).toBe(1);
    expect(skipped[2].porsiByKategori.PORSI_KECIL).toBe(50);

    const nextWeek = presentWeeklyMenuDays([], '2026-09-28');
    const merged = copyPorsiOntoDays(nextWeek, days[0].porsiByKategori, ['2026-09-29']);
    expect(merged.find((d) => d.tanggal === '2026-09-29')?.porsiByKategori.PORSI_KECIL).toBe(50);
    expect(merged.find((d) => d.tanggal === '2026-09-28')?.slots).toEqual({});
    const extra = copyPorsiOntoDays([], { ...emptyPortionTargets(), PORSI_KECIL: 9 }, ['2026-10-01']);
    expect(extra).toHaveLength(1);
    expect(extra[0].tanggal).toBe('2026-10-01');
    expect(extra[0].porsiByKategori.PORSI_KECIL).toBe(9);

    const daysWithLink = emptyWeeklyDays(WEEK_START);
    daysWithLink[1].productionPlanId = 'rpn-sel';
    const indexed = indexWeeklyRpnByTanggal(
      daysWithLink,
      [
        { id: 'rpn-sel', tanggal: '2026-09-22', status: 'APPROVED', weeklyMenuPlanId: 'w1' },
        { id: 'other', tanggal: '2026-09-22', status: 'DRAFT', weeklyMenuPlanId: 'w1' },
        { id: 'rpn-rab', tanggal: '2026-09-23', status: 'DRAFT', weeklyMenuPlanId: 'w1' },
      ],
      'w1',
    );
    expect(indexed['2026-09-22']?.status).toBe('APPROVED');
    expect(indexed['2026-09-23']?.status).toBe('DRAFT');
    expect(indexed['2026-09-21']).toBeUndefined();
  });

  it('clears hidangan and porsi but keeps the RPN link', () => {
    const day = emptyWeeklyDays(WEEK_START)[0];
    day.porsiByKategori.PORSI_KECIL = 100;
    day.slots = { KARBOHIDRAT: ['nasi'] };
    day.alergi = [{ recipeId: 'tahu', porsi: 2 }];
    day.note = 'catatan';
    day.productionPlanId = 'rpn-1';
    day.productionPlanNo = 'RPN2609000018';
    expect(dayHasMenuContent(day)).toBe(true);
    const cleared = clearWeeklyMenuDayContent(day);
    expect(cleared.slots).toEqual({});
    expect(cleared.alergi).toEqual([]);
    expect(cleared.note).toBe('');
    expect(cleared.porsiByKategori.PORSI_KECIL).toBe(0);
    expect(sumAllPorsi(cleared.porsiByKategori)).toBe(0);
    expect(cleared.productionPlanId).toBe('rpn-1');
    expect(cleared.productionPlanNo).toBe('RPN2609000018');
    expect(cleared.tanggal).toBe(WEEK_START);
    expect(dayHasMenuContent(cleared)).toBe(false);

    const restored = normalizeWeeklyDay(cleared, WEEK_START, day);
    expect(restored).not.toHaveProperty('error');
    if ('error' in restored) return;
    expect(restored.slots).toEqual({});
    expect(restored.alergi).toEqual([]);
    expect(restored.note).toBeUndefined();
    expect(sumAllPorsi(restored.porsiByKategori)).toBe(0);
    expect(restored.productionPlanId).toBe('rpn-1');
    expect(dayHasMenuContent({ ...restored, note: 'hanya catatan', porsiByKategori: emptyPortionTargets(), slots: {}, alergi: [] })).toBe(true);
  });

  it('rejects the same recipe across two slots or duplicate alergi', () => {
    const porsi = {
      PORSI_KECIL: 10,
      PORSI_BESAR: 0,
      POSYANDU_BALITA: 0,
      POSYANDU_BUMIL: 0,
      POSYANDU_BUSUI: 0,
      ORGANOLEPTIK: 0,
    };
    expect(assertDayReadyToPublish({
      tanggal: WEEK_START,
      porsiByKategori: porsi,
      slots: { KARBOHIDRAT: ['nasi'], SAYUR: ['nasi'] },
      alergi: [],
    })).toEqual({ error: expect.stringMatching(/dua kali di slot/i) });

    expect(assertDayReadyToPublish({
      tanggal: WEEK_START,
      porsiByKategori: porsi,
      slots: { KARBOHIDRAT: ['nasi'] },
      alergi: [{ recipeId: 'tahu', porsi: 1 }, { recipeId: 'tahu', porsi: 2 }],
    })).toEqual({ error: expect.stringMatching(/alergi duplikat/i) });
  });

  it('rejects publish when a recipe has no BOM lines', () => {
    const recipes = new Map<string, WeeklyRecipeRef>([
      ['nasi', recipe('nasi', 'KARBOHIDRAT', { lines: [] })],
    ]);
    expect(buildPublishPlanLines({
      tanggal: WEEK_START,
      porsiByKategori: {
        PORSI_KECIL: 10,
        PORSI_BESAR: 0,
        POSYANDU_BALITA: 0,
        POSYANDU_BUMIL: 0,
        POSYANDU_BUSUI: 0,
        ORGANOLEPTIK: 0,
      },
      slots: { KARBOHIDRAT: ['nasi'] },
      alergi: [],
    }, recipes)).toEqual({ error: expect.stringMatching(/belum punya bahan/i) });
  });

  it('presents six porsi keys and refuses edits to locked RPN days', () => {
    const presented = presentWeeklyMenuDays(
      [{
        tanggal: WEEK_START,
        porsiByKategori: { PORSI_KECIL: 5 } as never,
        slots: { KARBOHIDRAT: ['nasi'] },
        alergi: [],
      }],
      WEEK_START,
    );
    expect(presented).toHaveLength(5);
    expect(presented[0].porsiByKategori).toEqual({
      ...emptyPortionTargets(),
      PORSI_KECIL: 5,
    });
    expect(presented[0].slots.KARBOHIDRAT).toEqual(['nasi']);

    const previous = emptyWeeklyDays(WEEK_START);
    previous[0].slots = { KARBOHIDRAT: ['nasi'] };
    previous[0].productionPlanId = 'rpn-1';
    const incoming = emptyWeeklyDays(WEEK_START);
    incoming[0].slots = { KARBOHIDRAT: ['bubur'] };
    incoming[0].productionPlanId = 'rpn-1';
    expect(lockedDayEditError(previous, incoming, new Map([
      ['rpn-1', { status: 'APPROVED', noDokumen: 'RPN-9' }],
    ]))).toMatch(/terkunci/i);
    expect(lockedDayEditError(previous, previous, new Map([
      ['rpn-1', { status: 'APPROVED', noDokumen: 'RPN-9' }],
    ]))).toBeNull();
    expect(weeklyDayContentEqual(previous[0], previous[0])).toBe(true);
    expect(lockedDayEditError(previous, incoming, new Map([
      ['rpn-1', { status: 'SUBMITTED', noDokumen: 'RPN-9' }],
    ]))).toBeNull();
    expect(lockedDayEditError(previous, incoming, new Map([
      ['rpn-1', { status: 'PROCESSING', noDokumen: 'RPN-9' }],
    ]))).toMatch(/terkunci/i);
    expect(rpnPublishBlockedReason('APPROVED')).toMatch(/terkunci/i);
  });

  it('builds the same publish payload twice (idempotent lines)', () => {
    const day = {
      tanggal: WEEK_START,
      porsiByKategori: {
        PORSI_KECIL: 10,
        PORSI_BESAR: 20,
        POSYANDU_BALITA: 0,
        POSYANDU_BUMIL: 0,
        POSYANDU_BUSUI: 0,
        ORGANOLEPTIK: 0,
      },
      slots: { KARBOHIDRAT: ['nasi'] },
      alergi: [{ recipeId: 'tahu', porsi: 2 }],
    };
    const recipes = new Map<string, WeeklyRecipeRef>([
      ['nasi', recipe('nasi', 'KARBOHIDRAT')],
      ['tahu', recipe('tahu', 'LAUK_NABATI')],
    ]);
    const a = buildPublishPlanLines(day, recipes);
    const b = buildPublishPlanLines(day, recipes);
    expect(a).toEqual(b);
  });
});

describe('weekly menu plan — Fase 3 paket & Fase 4 copy/prefill', () => {
  it('applies a menu package into matching slots from recipe.kategoriMenu', () => {
    const day = emptyWeeklyDays(WEEK_START)[0];
    day.alergi = [{ recipeId: 'nasi', porsi: 2, catatan: 'akan terhapus karena tabrakan' }];
    const recipes = new Map<string, WeeklyRecipeRef>([
      ['nasi', recipe('nasi', 'KARBOHIDRAT')],
      ['ayam', recipe('ayam', 'LAUK_HEWANI')],
      ['sambal', recipe('sambal', 'GARNISH')],
    ]);
    const next = applyMenuPackageToDay(
      day,
      [
        { recipeId: 'nasi', kategoriMenu: 'SAYUR', bahanPangan: 'SAYUR' },
        { recipeId: 'ayam', kategoriMenu: 'LAUK_HEWANI', bahanPangan: 'PROTEIN_HEWANI' },
        { recipeId: 'sambal', kategoriMenu: 'GARNISH', bahanPangan: 'LAINNYA' },
      ],
      recipes,
    );
    expect('error' in next).toBe(false);
    if ('error' in next) return;
    expect(next.slots.KARBOHIDRAT).toEqual(['nasi']);
    expect(next.slots.LAUK_HEWANI).toEqual(['ayam']);
    expect(next.slots.GARNISH).toEqual(['sambal']);
    expect(next.alergi).toEqual([]);
  });

  it('copies previous week slots without RPN ids and skips locked days', () => {
    const source = emptyWeeklyDays(WEEK_START).map((d, i) => (
      i === 0
        ? {
          ...d,
          slots: { KARBOHIDRAT: ['nasi'] },
          note: 'Senin',
          alergi: [{ recipeId: 'tahu', porsi: 3 }],
          porsiByKategori: { ...emptyPortionTargets(), PORSI_BESAR: 40 },
          productionPlanId: 'old-rpn',
          productionPlanNo: 'RPN-OLD',
        }
        : d
    ));
    const targetStart = '2026-09-28';
    const target = emptyWeeklyDays(targetStart).map((d, i) => (
      i === 0
        ? { ...d, productionPlanId: 'new-rpn', productionPlanNo: 'RPN-NEW' }
        : d
    ));
    const copied = copyWeekDays(source, target, { copyPorsi: true, skipTanggal: [] });
    expect(copied[0].slots.KARBOHIDRAT).toEqual(['nasi']);
    expect(copied[0].note).toBe('Senin');
    expect(copied[0].alergi).toEqual([{ recipeId: 'tahu', porsi: 3 }]);
    expect(copied[0].porsiByKategori.PORSI_BESAR).toBe(40);
    expect(copied[0].productionPlanId).toBe('new-rpn');
    expect(copied[0].tanggal).toBe('2026-09-28');
    expect(copied[1].note).toBe('');
    copied[0].slots.KARBOHIDRAT!.push('extra');
    expect(source[0].slots.KARBOHIDRAT).toEqual(['nasi']);
    const skipped = copyWeekDays(source, target, { skipTanggal: ['2026-09-28'] });
    expect(skipped[0].slots.KARBOHIDRAT).toBeUndefined();
  });

  it('keeps target porsi when copyPorsi is false and clears inherited notes on PUT', () => {
    const source = emptyWeeklyDays(WEEK_START);
    source[0] = { ...source[0], slots: { SAYUR: ['bayam'] }, note: '' };
    const target = emptyWeeklyDays('2026-09-28');
    target[0] = {
      ...target[0],
      note: 'lama',
      porsiByKategori: { ...emptyPortionTargets(), PORSI_KECIL: 12 },
    };
    const copied = copyWeekDays(source, target, { copyPorsi: false });
    expect(copied[0].slots.SAYUR).toEqual(['bayam']);
    expect(copied[0].porsiByKategori.PORSI_KECIL).toBe(12);
    expect(copied[0].note).toBe('');
    const persisted = normalizeWeeklyDay(copied[0], copied[0].tanggal, target[0]);
    expect('error' in persisted).toBe(false);
    if ('error' in persisted) return;
    expect(persisted.note).toBeUndefined();
    expect(persisted.porsiByKategori.PORSI_KECIL).toBe(12);
  });

  it('keeps porsi/note/RPN id when applying a package; rejects inactive and duplicate recipes', () => {
    const day = {
      ...emptyWeeklyDays(WEEK_START)[0],
      note: 'tetap',
      porsiByKategori: { ...emptyPortionTargets(), PORSI_BESAR: 88 },
      productionPlanId: 'rpn-1',
    };
    const recipes = new Map<string, WeeklyRecipeRef>([
      ['nasi', recipe('nasi', 'KARBOHIDRAT')],
      ['mati', recipe('mati', 'SAYUR', { aktif: false })],
    ]);
    const ok = applyMenuPackageToDay(day, [{ recipeId: 'nasi' }], recipes);
    expect('error' in ok).toBe(false);
    if ('error' in ok) return;
    expect(ok.note).toBe('tetap');
    expect(ok.porsiByKategori.PORSI_BESAR).toBe(88);
    expect(ok.productionPlanId).toBe('rpn-1');
    expect(applyMenuPackageToDay(day, [{ recipeId: 'mati' }], recipes)).toEqual(
      expect.objectContaining({ error: expect.stringMatching(/nonaktif/) }),
    );
    expect(applyMenuPackageToDay(day, [{ recipeId: 'nasi' }, { recipeId: 'nasi' }], recipes)).toEqual(
      expect.objectContaining({ error: expect.stringMatching(/dua kali/) }),
    );
  });

  it('sums active service-point porsi into 6 keys', () => {
    const sum = sumServicePointPorsi([
      { aktif: true, porsiByKategori: { PORSI_KECIL: 10, PORSI_BESAR: 20, POSYANDU_BUMIL: 5 } },
      { aktif: false, porsiByKategori: { PORSI_KECIL: 99 } },
      { porsiByKategori: { PORSI_BESAR: 3, ORGANOLEPTIK: 2 } },
    ]);
    expect(sum.PORSI_KECIL).toBe(10);
    expect(sum.PORSI_BESAR).toBe(23);
    expect(sum.POSYANDU_BUMIL).toBe(5);
    expect(sum.ORGANOLEPTIK).toBe(2);
    expect(sum.POSYANDU_BALITA).toBe(0);
    const legacy = sumServicePointPorsi([
      { porsiByKategori: { POSYANDU_BUMIL_BUSUI: 8 } },
    ]);
    expect(legacy.POSYANDU_BUMIL).toBe(8);
    expect(legacy.POSYANDU_BUSUI).toBe(0);
  });

  it('builds draft nutrition lines from slots + alergi', () => {
    const lines = draftNutritionLinesFromDay({
      porsiByKategori: { ...emptyPortionTargets(), PORSI_BESAR: 10, ORGANOLEPTIK: 2 },
      slots: { KARBOHIDRAT: ['nasi'] },
      alergi: [{ recipeId: 'tahu', porsi: 4 }],
    });
    expect(lines[0]).toEqual({
      recipeId: 'nasi',
      targetPorsi: 12,
      kategoriPorsiList: ['PORSI_BESAR', 'ORGANOLEPTIK'],
    });
    expect(lines[1].recipeId).toBe('tahu');
    expect(lines[1].targetPorsi).toBe(4);
  });

  it('uses PORSI_BESAR for mixed or empty AKG chips', () => {
    expect(akgKeyForDay({ ...emptyPortionTargets(), PORSI_KECIL: 10 })).toBe('PORSI_KECIL');
    expect(akgKeyForDay({ ...emptyPortionTargets(), PORSI_KECIL: 10, PORSI_BESAR: 5 })).toBe('PORSI_BESAR');
    expect(akgKeyForDay(emptyPortionTargets())).toBe('PORSI_BESAR');
  });
});
