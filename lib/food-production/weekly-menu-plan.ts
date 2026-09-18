/**
 * Weekly menu plan — Fase 1 perencanaan ahli gizi (Sen–Jum).
 * Slot = recipeId dari master. Terbit → portion_targets + RPN harian.
 */

import {
  KATEGORI_MENU_OPTIONS,
  isKategoriMenu,
  type KategoriMenu,
} from '@/lib/food-production/recipe';
import {
  resolveMenuItemKategoriMenu,
} from '@/lib/food-production/menu';
import {
  emptyPortionTargets,
  normalizePortionTargets,
  sumAllPorsi,
  sumPosyanduPorsi,
  sumSekolahPorsi,
  type PortionTargetMap,
} from '@/lib/food-production/portion-target';
import {
  KATEGORI_PORSI_LEGACY,
  KATEGORI_PORSI_OPTIONS,
  RECIPE_NEED_BUFFER_PCT,
  isIsoDate,
  shiftIsoDate,
  type KategoriPorsiCurrent,
  type ProductionPlanLine,
} from '@/lib/food-production/production-plan';

export const WEEKLY_MENU_PLANS_COLLECTION = 'weekly_menu_plans';

export const WEEKLY_MENU_WEEKDAYS = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'] as const;

export type WeeklyMenuPlanStatus = 'DRAFT' | 'PUBLISHED';

export interface WeeklyMenuAlergi {
  recipeId: string;
  porsi: number;
  catatan?: string;
}

export type WeeklyMenuSlots = Partial<Record<KategoriMenu, string[]>>;

export interface WeeklyMenuDay {
  tanggal: string;
  porsiByKategori: PortionTargetMap;
  slots: WeeklyMenuSlots;
  note?: string;
  alergi: WeeklyMenuAlergi[];
  productionPlanId?: string;
  productionPlanNo?: string;
}

export interface WeeklyMenuPlanDoc {
  id: string;
  tenantId: string;
  kitchenId: string;
  kitchenNama?: string;
  weekStart: string;
  status: WeeklyMenuPlanStatus;
  days: WeeklyMenuDay[];
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
  updatedBy?: string;
  updatedByName?: string;
}

export type WeeklyRecipeRef = {
  id: string;
  kode?: string;
  nama?: string;
  aktif?: boolean;
  kategoriMenu?: string | null;
  lines?: unknown[];
};

function utcWeekdayMon1(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

export function weekStartFrom(date: string): string | { error: string } {
  if (!isIsoDate(date)) return { error: 'Tanggal tidak valid (YYYY-MM-DD)' };
  const wd = utcWeekdayMon1(date);
  const start = shiftIsoDate(date, 1 - wd);
  if (!start) return { error: 'Tanggal tidak valid (YYYY-MM-DD)' };
  return start;
}

export function assertWeekStart(date: unknown): string | { error: string } {
  const raw = String(date || '').trim();
  if (!isIsoDate(raw)) return { error: 'weekStart wajib Senin (YYYY-MM-DD)' };
  if (utcWeekdayMon1(raw) !== 1) return { error: 'weekStart wajib hari Senin' };
  return raw;
}

export function isoWeekdays(weekStart: string): string[] {
  return [0, 1, 2, 3, 4].map((offset) => shiftIsoDate(weekStart, offset));
}

const WEEK_MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'] as const;

function isoEpochDays(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function weekDelta(weekStart: string, todayWeekStart: string): number {
  return Math.round((isoEpochDays(weekStart) - isoEpochDays(todayWeekStart)) / 7);
}

/** Label relatif ke minggu berjalan: Minggu ini / lalu / depan / N minggu … */
export function relativeWeekLabel(weekStart: string, todayWeekStart: string): string {
  const n = weekDelta(weekStart, todayWeekStart);
  if (n === 0) return 'Minggu ini';
  if (n === 1) return 'Minggu depan';
  if (n === -1) return 'Minggu lalu';
  if (n === 2) return '2 minggu ke depan';
  if (n === -2) return '2 minggu lalu';
  if (n > 0) return `${n} minggu ke depan`;
  return `${Math.abs(n)} minggu lalu`;
}

const MENU_CALENDAR_TZ = 'Asia/Jakarta';

/** Tanggal operasional SPPG (WIB), bukan UTC — "Minggu ini" tidak mundur sebelum jam 07. */
export function localIsoDate(now = new Date(), timeZone = MENU_CALENDAR_TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function formatWeekRangeId(weekStart: string): string {
  const days = isoWeekdays(weekStart);
  const sen = days[0];
  const jum = days[4];
  if (!sen || !jum) return weekStart;
  const senD = Number(sen.slice(8, 10));
  const jumD = Number(jum.slice(8, 10));
  const senM = Number(sen.slice(5, 7));
  const jumM = Number(jum.slice(5, 7));
  const senY = sen.slice(0, 4);
  const jumY = jum.slice(0, 4);
  if (senM === jumM) {
    return `Sen ${senD} – Jum ${jumD} ${WEEK_MONTHS_ID[jumM - 1]} ${jumY}`;
  }
  if (senY === jumY) {
    return `Sen ${senD} ${WEEK_MONTHS_ID[senM - 1]} – Jum ${jumD} ${WEEK_MONTHS_ID[jumM - 1]} ${jumY}`;
  }
  return `Sen ${senD} ${WEEK_MONTHS_ID[senM - 1]} ${senY} – Jum ${jumD} ${WEEK_MONTHS_ID[jumM - 1]} ${jumY}`;
}

/** Label toast salin porsi: `Selasa 22 Sep`. */
export function formatCopyPorsiDayLabel(tanggal: string): string {
  const start = weekStartFrom(tanggal);
  const d = Number(String(tanggal || '').slice(8, 10));
  const m = Number(String(tanggal || '').slice(5, 7));
  const mon = WEEK_MONTHS_ID[m - 1] || '';
  if (typeof start !== 'string' || !d || !mon) return String(tanggal || '').trim();
  const idx = isoWeekdays(start).indexOf(tanggal);
  const hari = idx >= 0 ? WEEKLY_MENU_WEEKDAYS[idx] : '';
  return `${hari} ${d} ${mon}`.trim();
}

/** Jendela minggu: center di tengah, `span` ke kiri/kanan (default 5 chip). */
export function weekWindow(center: string, span = 2): string[] {
  const monday = assertWeekStart(center);
  const start = typeof monday === 'string' ? monday : weekStartFrom(center);
  if (typeof start !== 'string') return [];
  const out: string[] = [];
  for (let i = -span; i <= span; i += 1) {
    const next = shiftIsoDate(start, i * 7);
    if (next) out.push(next);
  }
  return out;
}

export function groupDatesByWeekStart(dates: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const tanggal of dates) {
    const start = weekStartFrom(tanggal);
    if (typeof start !== 'string') continue;
    const list = map.get(start) || [];
    list.push(tanggal);
    map.set(start, list);
  }
  return map;
}

export function emptyWeeklyMenuDay(tanggal: string): WeeklyMenuDay {
  return {
    tanggal,
    porsiByKategori: emptyPortionTargets(),
    slots: {},
    alergi: [],
  };
}

export function emptyWeeklyDays(weekStart: string): WeeklyMenuDay[] {
  return isoWeekdays(weekStart).map((tanggal) => emptyWeeklyMenuDay(tanggal));
}

export function normalizeSlots(raw: unknown): WeeklyMenuSlots | { error: string } {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'slots harus object per kategori menu' };
  }
  const obj = raw as Record<string, unknown>;
  const out: WeeklyMenuSlots = {};
  for (const opt of KATEGORI_MENU_OPTIONS) {
    const listRaw = obj[opt.value];
    if (listRaw == null) continue;
    if (!Array.isArray(listRaw)) {
      return { error: `Slot ${opt.label}: daftar resep tidak valid` };
    }
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const item of listRaw) {
      const id = String(item || '').trim();
      if (!id) continue;
      if (seen.has(id)) {
        return { error: `Slot ${opt.label}: resep duplikat` };
      }
      seen.add(id);
      ids.push(id);
    }
    if (ids.length) out[opt.value] = ids;
  }
  for (const key of Object.keys(obj)) {
    if (key && !isKategoriMenu(key) && obj[key] != null) {
      return { error: `Kategori menu tidak valid: ${key}` };
    }
  }
  return out;
}

export function normalizeAlergi(raw: unknown): WeeklyMenuAlergi[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: 'alergi harus array' };
  const out: WeeklyMenuAlergi[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = (raw[i] || {}) as Record<string, unknown>;
    const recipeId = String(row.recipeId || '').trim();
    if (!recipeId) return { error: `Alergi ${i + 1}: resep wajib` };
    const porsi = Number(row.porsi);
    if (!Number.isFinite(porsi) || porsi <= 0) {
      return { error: `Alergi ${i + 1}: porsi harus > 0` };
    }
    const catatan = String(row.catatan || '').trim();
    out.push({
      recipeId,
      porsi: Math.round(porsi),
      ...(catatan ? { catatan } : {}),
    });
  }
  return out;
}

export function slotRecipeIds(slots: WeeklyMenuSlots | null | undefined): string[] {
  const ids: string[] = [];
  for (const opt of KATEGORI_MENU_OPTIONS) {
    for (const id of slots?.[opt.value] || []) {
      if (id) ids.push(id);
    }
  }
  return ids;
}

export function dayRecipeIds(day: Pick<WeeklyMenuDay, 'slots' | 'alergi'>): string[] {
  return [...slotRecipeIds(day.slots), ...(day.alergi || []).map((a) => a.recipeId)];
}

export function porsiKategoriWithQty(map: PortionTargetMap): KategoriPorsiCurrent[] {
  return KATEGORI_PORSI_OPTIONS.map((o) => o.value).filter((k) => (Number(map[k]) || 0) > 0);
}

export function alergiKategoriPorsi(map: PortionTargetMap): KategoriPorsiCurrent {
  return (Number(map.ORGANOLEPTIK) || 0) > 0 ? 'ORGANOLEPTIK' : 'PORSI_BESAR';
}

export function uniqueDayRecipesError(
  day: Pick<WeeklyMenuDay, 'slots' | 'alergi'>,
): string | null {
  const seenSlots = new Set<string>();
  for (const id of slotRecipeIds(day.slots)) {
    if (seenSlots.has(id)) return 'resep muncul dua kali di slot';
    seenSlots.add(id);
  }
  const alergiSeen = new Set<string>();
  for (const row of day.alergi || []) {
    if (seenSlots.has(row.recipeId)) {
      return 'resep alergi tidak boleh sama dengan slot';
    }
    if (alergiSeen.has(row.recipeId)) return 'resep alergi duplikat';
    alergiSeen.add(row.recipeId);
  }
  return null;
}

export function weeklyDayContentKey(day: Pick<WeeklyMenuDay, 'porsiByKategori' | 'slots' | 'alergi' | 'note'>) {
  return {
    porsiByKategori: day.porsiByKategori,
    slots: day.slots || {},
    alergi: day.alergi || [],
    note: String(day.note || ''),
  };
}

export function weeklyDayContentEqual(
  a: Pick<WeeklyMenuDay, 'porsiByKategori' | 'slots' | 'alergi' | 'note'>,
  b: Pick<WeeklyMenuDay, 'porsiByKategori' | 'slots' | 'alergi' | 'note'>,
): boolean {
  return JSON.stringify(weeklyDayContentKey(a)) === JSON.stringify(weeklyDayContentKey(b));
}

export function lockedDayEditError(
  previous: WeeklyMenuDay[],
  incoming: WeeklyMenuDay[],
  rpnById: Map<string, { status?: string; noDokumen?: string }>,
): string | null {
  const nextByDate = new Map(incoming.map((d) => [d.tanggal, d]));
  for (const prev of previous) {
    if (!prev.productionPlanId) continue;
    const rpn = rpnById.get(prev.productionPlanId);
    if (!rpn) continue;
    const blocked = rpnPublishBlockedReason(rpn.status);
    if (!blocked) continue;
    const next = nextByDate.get(prev.tanggal);
    if (!next) continue;
    if (!weeklyDayContentEqual(prev, next)) {
      return `${prev.tanggal}: ${blocked}${rpn.noDokumen ? ` (${rpn.noDokumen})` : ''}`;
    }
  }
  return null;
}

export function assertDayReadyToPublish(
  day: Pick<WeeklyMenuDay, 'tanggal' | 'porsiByKategori' | 'slots' | 'alergi'>,
): { error: string } | { ok: true; total: number; kategoriPorsiList: KategoriPorsiCurrent[] } {
  const slotIds = slotRecipeIds(day.slots);
  if (!slotIds.length) {
    return { error: `${day.tanggal}: minimal satu resep di slot` };
  }
  const uniqueErr = uniqueDayRecipesError(day);
  if (uniqueErr) return { error: `${day.tanggal}: ${uniqueErr}` };
  for (const row of day.alergi || []) {
    if (!(Number(row.porsi) > 0)) {
      return { error: `${day.tanggal}: porsi alergi harus > 0` };
    }
  }
  const total = sumAllPorsi(day.porsiByKategori);
  if (!(total > 0)) return { error: `${day.tanggal}: total penerima manfaat harus > 0` };
  const kategoriPorsiList = porsiKategoriWithQty(day.porsiByKategori);
  if (!kategoriPorsiList.length) {
    return { error: `${day.tanggal}: minimal satu kategori porsi terisi` };
  }
  return { ok: true, total, kategoriPorsiList };
}

export function validateDayRecipes(
  day: Pick<WeeklyMenuDay, 'tanggal' | 'slots' | 'alergi'>,
  recipesById: Map<string, WeeklyRecipeRef>,
): { error?: string; warnings: string[] } {
  const warnings: string[] = [];
  const check = (recipeId: string, slot?: KategoriMenu, asAlergi = false) => {
    const recipe = recipesById.get(recipeId);
    const label = asAlergi ? 'alergi' : (slot ? slot : 'slot');
    if (!recipe) return `${day.tanggal}: resep ${recipeId} (${label}) tidak ditemukan`;
    if (recipe.aktif === false) {
      return `${day.tanggal}: resep ${recipe.kode || recipeId} nonaktif`;
    }
    if (slot && recipe.kategoriMenu && recipe.kategoriMenu !== slot) {
      return `${day.tanggal}: ${recipe.kode || recipeId} bukan slot ${slot}`;
    }
    if (slot && !recipe.kategoriMenu) {
      warnings.push(`${day.tanggal}: ${recipe.kode || recipeId} belum punya kategori menu`);
    }
    if (!Array.isArray(recipe.lines) || recipe.lines.length === 0) {
      return `${day.tanggal}: resep ${recipe.kode || recipeId} belum punya bahan`;
    }
    return null;
  };

  for (const opt of KATEGORI_MENU_OPTIONS) {
    for (const id of day.slots?.[opt.value] || []) {
      const err = check(id, opt.value);
      if (err) return { error: err, warnings };
    }
  }
  for (const row of day.alergi || []) {
    const err = check(row.recipeId, undefined, true);
    if (err) return { error: err, warnings };
  }
  return { warnings };
}

export function publishRecipeBufferPct(recipeIds: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of recipeIds) {
    if (id) out[id] = RECIPE_NEED_BUFFER_PCT;
  }
  return out;
}

export function buildPublishPlanLines(
  day: Pick<WeeklyMenuDay, 'tanggal' | 'porsiByKategori' | 'slots' | 'alergi' | 'note'>,
  recipesById: Map<string, WeeklyRecipeRef>,
): {
  lines: ProductionPlanLine[];
  kategoriPorsiList: KategoriPorsiCurrent[];
  recipeBufferPct: Record<string, number>;
  catatan?: string;
  total: number;
  warnings: string[];
} | { error: string } {
  const ready = assertDayReadyToPublish(day);
  if ('error' in ready) return ready;
  const validated = validateDayRecipes(day, recipesById);
  if (validated.error) return { error: validated.error };

  const lines: ProductionPlanLine[] = [];
  for (const opt of KATEGORI_MENU_OPTIONS) {
    for (const recipeId of day.slots?.[opt.value] || []) {
      const recipe = recipesById.get(recipeId)!;
      lines.push({
        recipeId,
        recipeKode: recipe.kode,
        recipeNama: recipe.nama,
        kategoriPorsiList: ready.kategoriPorsiList,
        targetPorsi: ready.total,
      });
    }
  }
  const alergiKp: KategoriPorsiCurrent[] = [alergiKategoriPorsi(day.porsiByKategori)];
  for (const row of day.alergi || []) {
    const recipe = recipesById.get(row.recipeId)!;
    lines.push({
      recipeId: row.recipeId,
      recipeKode: recipe.kode,
      recipeNama: recipe.nama,
      kategoriPorsiList: alergiKp,
      targetPorsi: row.porsi,
      notes: row.catatan ? `ALERGI: ${row.catatan}` : 'ALERGI',
    });
  }

  const recipeBufferPct = publishRecipeBufferPct(lines.map((l) => String(l.recipeId || '')));
  const catatan = String(day.note || '').trim() || undefined;
  return {
    lines,
    kategoriPorsiList: ready.kategoriPorsiList,
    recipeBufferPct,
    catatan,
    total: ready.total,
    warnings: validated.warnings,
  };
}

const RPN_LOCKED = new Set(['APPROVED', 'PROCESSING', 'COMPLETED']);

export function rpnPublishBlockedReason(status: string | null | undefined): string | null {
  const st = String(status || '').trim();
  if (!st) return null;
  if (RPN_LOCKED.has(st)) {
    return `RPN status ${st} terkunci — tidak bisa ditimpa dari perencanaan menu`;
  }
  return null;
}

type WeeklyRpnIndexRow = {
  id?: string;
  tanggal?: string;
  weeklyMenuPlanId?: string | null;
};

/** RPN yang mengunci/menandai hari di papan: tautan productionPlanId, else weeklyMenuPlanId. */
export function indexWeeklyRpnByTanggal<T extends WeeklyRpnIndexRow>(
  days: Array<{ tanggal: string; productionPlanId?: string }>,
  rows: T[],
  weeklyMenuPlanId?: string | null,
): Record<string, T> {
  const byDate = new Map(days.map((d) => [d.tanggal, d]));
  const wid = String(weeklyMenuPlanId || '').trim();
  const map: Record<string, T> = {};
  for (const row of rows) {
    const tgl = String(row.tanggal || '').slice(0, 10);
    if (!tgl) continue;
    const linked = String(byDate.get(tgl)?.productionPlanId || '').trim();
    if (linked) {
      if (String(row.id || '') === linked) map[tgl] = row;
      continue;
    }
    if (wid && String(row.weeklyMenuPlanId || '').trim() === wid) map[tgl] = row;
  }
  return map;
}

/** Pilih RPN yang di-upsert publish: prefer tautan papan, lalu ad-hoc DRAFT/SUBMITTED. */
export function selectPublishTargetPlan<T extends {
  status?: string;
  noDokumen?: string;
  weeklyMenuPlanId?: string | null;
}>(
  candidates: T[],
  weeklyMenuPlanId: string,
): { error: string } | { plan: T | null } {
  const wid = String(weeklyMenuPlanId || '').trim();
  const active = candidates.filter((p) => String(p.status || '').trim() !== 'CANCELLED');
  for (const p of active) {
    const blocked = rpnPublishBlockedReason(p.status);
    if (blocked) return { error: `${blocked} (${p.noDokumen || 'RPN'})` };
  }
  const linked = wid
    ? active.filter((p) => String(p.weeklyMenuPlanId || '').trim() === wid)
    : [];
  const pool = linked.length ? linked : active;
  const editable = pool.find((p) => {
    const st = String(p.status || '').trim();
    return st === 'DRAFT' || st === 'SUBMITTED';
  });
  return { plan: editable || null };
}

export function normalizeWeeklyDay(
  raw: unknown,
  tanggal: string,
  previous?: WeeklyMenuDay,
): WeeklyMenuDay | { error: string } {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const porsi = normalizePortionTargets(row.porsiByKategori ?? previous?.porsiByKategori);
  if ('error' in porsi) return porsi;
  const slots = normalizeSlots(row.slots ?? previous?.slots);
  if ('error' in slots) return slots;
  const alergi = normalizeAlergi(row.alergi ?? previous?.alergi);
  if ('error' in alergi) return alergi;
  const note = String(row.note ?? previous?.note ?? '').trim();
  const uniqueErr = uniqueDayRecipesError({ slots, alergi });
  if (uniqueErr) return { error: uniqueErr };
  const productionPlanId = String(previous?.productionPlanId || '').trim();
  const productionPlanNo = String(previous?.productionPlanNo || '').trim();
  return {
    tanggal,
    porsiByKategori: porsi,
    slots,
    alergi,
    ...(note ? { note } : {}),
    ...(productionPlanId ? { productionPlanId } : {}),
    ...(productionPlanNo ? { productionPlanNo } : {}),
  };
}

export function normalizeWeeklyDays(
  raw: unknown,
  weekStart: string,
  previous?: WeeklyMenuDay[],
): WeeklyMenuDay[] | { error: string } {
  const dates = isoWeekdays(weekStart);
  const prevByDate = new Map((previous || []).map((d) => [d.tanggal, d]));
  const incoming = Array.isArray(raw) ? raw : [];
  const byDate = new Map<string, unknown>();
  for (const item of incoming) {
    const row = (item || {}) as Record<string, unknown>;
    const tanggal = String(row.tanggal || '').trim();
    if (tanggal) byDate.set(tanggal, row);
  }
  const days: WeeklyMenuDay[] = [];
  for (const tanggal of dates) {
    const day = normalizeWeeklyDay(byDate.get(tanggal), tanggal, prevByDate.get(tanggal));
    if ('error' in day) return { error: `${tanggal}: ${day.error}` };
    days.push(day);
  }
  return days;
}

/** Tempel porsi ke tanggal tujuan; tanggal yang belum ada di `days` ditambah. */
export function copyPorsiOntoDays(
  days: WeeklyMenuDay[],
  porsi: PortionTargetMap,
  toTanggal: string[],
  skipTanggal?: Iterable<string>,
): WeeklyMenuDay[] {
  const skip = new Set(skipTanggal || []);
  const targets = [...new Set(toTanggal.filter((t) => isIsoDate(t) && !skip.has(t)))];
  if (!targets.length) return days;
  const byDate = new Map(days.map((d) => [d.tanggal, d]));
  for (const tanggal of targets) {
    const existing = byDate.get(tanggal) || emptyWeeklyMenuDay(tanggal);
    byDate.set(tanggal, { ...existing, tanggal, porsiByKategori: { ...porsi } });
  }
  const seen = new Set<string>();
  const out: WeeklyMenuDay[] = [];
  for (const day of days) {
    out.push(byDate.get(day.tanggal) || day);
    seen.add(day.tanggal);
  }
  for (const tanggal of targets) {
    if (seen.has(tanggal)) continue;
    const row = byDate.get(tanggal);
    if (row) out.push(row);
  }
  return out;
}

export function copyPorsiToDays(
  days: WeeklyMenuDay[],
  fromTanggal: string,
  toTanggal: string[],
  skipTanggal?: Iterable<string>,
): WeeklyMenuDay[] {
  const source = days.find((d) => d.tanggal === fromTanggal);
  if (!source) return days;
  return copyPorsiOntoDays(
    days,
    source.porsiByKategori,
    toTanggal.filter((t) => t !== fromTanggal),
    skipTanggal,
  );
}

export function presentWeeklyMenuDays(
  days: WeeklyMenuDay[] | null | undefined,
  weekStart: string,
): WeeklyMenuDay[] {
  const dates = isoWeekdays(weekStart);
  const byDate = new Map((days || []).map((d) => [d.tanggal, d]));
  return dates.map((tanggal) => {
    const d = byDate.get(tanggal) || emptyWeeklyMenuDay(tanggal);
    const porsi = normalizePortionTargets(d.porsiByKategori);
    return {
      ...d,
      tanggal,
      porsiByKategori: 'error' in porsi ? emptyPortionTargets() : porsi,
      slots: d.slots || {},
      alergi: Array.isArray(d.alergi) ? d.alergi : [],
    };
  });
}

export function dayPorsiSummary(day: Pick<WeeklyMenuDay, 'porsiByKategori'>) {
  return {
    sekolah: sumSekolahPorsi(day.porsiByKategori),
    posyandu: sumPosyanduPorsi(day.porsiByKategori),
    total: sumAllPorsi(day.porsiByKategori),
  };
}

export function weeklyPlanStatusFromDays(days: WeeklyMenuDay[]): WeeklyMenuPlanStatus {
  return days.some((d) => d.productionPlanId) ? 'PUBLISHED' : 'DRAFT';
}

export function dayHasSlotContent(day: Pick<WeeklyMenuDay, 'slots' | 'alergi' | 'note'>): boolean {
  return slotRecipeIds(day.slots).length > 0
    || (day.alergi || []).length > 0
    || Boolean(String(day.note || '').trim());
}

export function weekHasSlotContent(days: WeeklyMenuDay[]): boolean {
  return days.some((d) => dayHasSlotContent(d));
}

/**
 * Isi slot satu hari dari paket menu. Resep master = sumber slot.
 * Tidak menyalin porsi/note/alergi. Tidak menulis productionPlanId.
 */
/** Payload paket dari API — kategoriMenu masih string longgar. */
type MenuPackageItemInput = {
  recipeId: string;
  recipeKode?: string;
  kategoriMenu?: string | null;
  bahanPangan?: string;
};

export function applyMenuPackageToDay(
  day: WeeklyMenuDay,
  items: MenuPackageItemInput[],
  recipesById: Map<string, WeeklyRecipeRef>,
): WeeklyMenuDay | { error: string; warnings?: string[] } {
  if (!items.length) return { error: 'Paket menu kosong' };
  const slots: WeeklyMenuSlots = {};
  const seen = new Set<string>();
  for (const item of items) {
    const recipeId = String(item.recipeId || '').trim();
    if (!recipeId) continue;
    if (seen.has(recipeId)) {
      return { error: `resep ${item.recipeKode || recipeId} muncul dua kali di paket` };
    }
    const recipe = recipesById.get(recipeId);
    if (!recipe) return { error: `resep ${recipeId} tidak ditemukan` };
    if (recipe.aktif === false) {
      return { error: `resep ${recipe.kode || recipeId} nonaktif` };
    }
    let slot: KategoriMenu | null = isKategoriMenu(recipe.kategoriMenu)
      ? recipe.kategoriMenu
      : resolveMenuItemKategoriMenu(item);
    if (!slot) {
      return { error: `resep ${recipe.kode || recipeId} belum punya kategori menu` };
    }
    if (recipe.kategoriMenu && isKategoriMenu(recipe.kategoriMenu) && recipe.kategoriMenu !== slot) {
      slot = recipe.kategoriMenu;
    }
    seen.add(recipeId);
    slots[slot] = [...(slots[slot] || []), recipeId];
  }
  if (!slotRecipeIds(slots).length) return { error: 'Paket tidak punya resep yang bisa diisi ke slot' };
  const alergi = (day.alergi || []).filter((row) => !seen.has(row.recipeId));
  const uniqueErr = uniqueDayRecipesError({ slots, alergi });
  if (uniqueErr) return { error: uniqueErr };
  return {
    ...day,
    slots,
    alergi,
  };
}

export function applyMenuPackageWarnings(
  items: MenuPackageItemInput[],
  recipesById: Map<string, WeeklyRecipeRef>,
): string[] {
  const warnings: string[] = [];
  for (const item of items) {
    const recipe = recipesById.get(String(item.recipeId || ''));
    if (recipe && !recipe.kategoriMenu) {
      warnings.push(`${recipe.kode || item.recipeId} belum punya kategori menu`);
    }
  }
  return warnings;
}

/** Salin slot/note/alergi antar minggu (indeks Sen–Jum). Tidak menyalin tautan RPN. */
export function copyWeekDays(
  sourceDays: WeeklyMenuDay[],
  targetDays: WeeklyMenuDay[],
  opts?: { copyPorsi?: boolean; skipTanggal?: Iterable<string> },
): WeeklyMenuDay[] {
  const skip = new Set(opts?.skipTanggal || []);
  const copyPorsi = opts?.copyPorsi !== false;
  return targetDays.map((day, i) => {
    if (skip.has(day.tanggal)) return day;
    const src = sourceDays[i];
    if (!src) return day;
    return {
      ...day,
      slots: cloneSlots(src.slots),
      alergi: cloneAlergi(src.alergi),
      // string kosong agar PUT tidak mewarisi note lama (?? previous).
      note: String(src.note || '').trim(),
      ...(copyPorsi ? { porsiByKategori: { ...emptyPortionTargets(), ...src.porsiByKategori } } : {}),
    };
  });
}

export function sumServicePointPorsi(
  points: Array<{ aktif?: boolean; porsiByKategori?: Partial<Record<string, number>> | null }>,
): PortionTargetMap {
  const out = emptyPortionTargets();
  for (const pt of points) {
    if (pt.aktif === false) continue;
    const n = normalizePortionTargets(pt.porsiByKategori);
    const map = 'error' in n ? emptyPortionTargets() : n;
    for (const opt of KATEGORI_PORSI_OPTIONS) {
      out[opt.value] += Math.max(0, Number(map[opt.value]) || 0);
    }
  }
  return out;
}

function cloneSlots(slots: WeeklyMenuSlots | null | undefined): WeeklyMenuSlots {
  const out: WeeklyMenuSlots = {};
  for (const opt of KATEGORI_MENU_OPTIONS) {
    const ids = slots?.[opt.value];
    if (Array.isArray(ids) && ids.length) out[opt.value] = [...ids];
  }
  return out;
}

function cloneAlergi(rows: WeeklyMenuAlergi[] | null | undefined): WeeklyMenuAlergi[] {
  return (rows || []).map((row) => ({ ...row }));
}

/** Chip gizi: MIXED / kosong / legacy Bumil+Busui → PORSI_BESAR (analyzer hanya 2 profil). */
export function akgKeyForDay(map: PortionTargetMap): 'PORSI_KECIL' | 'PORSI_BESAR' {
  const kecil = (Number(map.PORSI_KECIL) || 0) + (Number(map.POSYANDU_BALITA) || 0);
  const besar = (Number(map.PORSI_BESAR) || 0)
    + (Number(map.POSYANDU_BUMIL) || 0)
    + (Number(map.POSYANDU_BUSUI) || 0)
    + (Number(map.ORGANOLEPTIK) || 0)
    + (Number((map as Partial<Record<string, number>>)[KATEGORI_PORSI_LEGACY]) || 0);
  if (kecil > 0 && besar <= 0) return 'PORSI_KECIL';
  return 'PORSI_BESAR';
}

export function draftNutritionLinesFromDay(
  day: Pick<WeeklyMenuDay, 'porsiByKategori' | 'slots' | 'alergi'>,
): Array<{ recipeId: string; targetPorsi: number; kategoriPorsiList: string[] }> {
  const total = sumAllPorsi(day.porsiByKategori);
  const kp = porsiKategoriWithQty(day.porsiByKategori);
  const kategoriPorsiList = kp.length ? kp : ['PORSI_BESAR'];
  const out: Array<{ recipeId: string; targetPorsi: number; kategoriPorsiList: string[] }> = [];
  if (total > 0) {
    for (const recipeId of slotRecipeIds(day.slots)) {
      out.push({ recipeId, targetPorsi: total, kategoriPorsiList });
    }
  }
  const alergiKp = [alergiKategoriPorsi(day.porsiByKategori)];
  for (const row of day.alergi || []) {
    const porsi = Number(row.porsi) || 0;
    if (!(porsi > 0) || !row.recipeId) continue;
    out.push({
      recipeId: row.recipeId,
      targetPorsi: porsi,
      kategoriPorsiList: alergiKp,
    });
  }
  return out;
}
