/**
 * Tanggal kalender (hari, bukan timestamp).
 * ISO date-only dan Date UTC dibaca dari bagian tanggal UTC,
 * supaya tidak geser hari di zona WIB vs UTC.
 */

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/;

export function isIsoDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === value;
}

/** YYYY-MM-DD dari string/Date.
 *  - string ISO tanggal / T00 / T12 UTC → hari kalender tersimpan (tanpa geser zona)
 *  - Date timestamp (bukan midnight/noon UTC) → hari lokal mesin
 */
export function calendarDateKey(value: unknown): string {
  if (value == null || value === '') return '';
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return '';
    const iso = value.toISOString();
    const utcHour = iso.slice(11, 13);
    if (utcHour === '00' || utcHour === '12') return iso.slice(0, 10);
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const raw = String(value).trim();
  const isoDay = raw.match(ISO_DAY);
  if (isoDay) {
    if (raw.length === 10 || /T00:00:00/.test(raw) || /T12:00:00/.test(raw)) {
      return isoDay[1];
    }
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) return calendarDateKey(parsed);
    return isoDay[1];
  }
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return '';
  return calendarDateKey(parsed);
}

/** Simpan tanggal kalender di tengah hari UTC — aman di semua zona. */
export function calendarDateAtUtcNoon(isoDay: string): Date {
  const key = calendarDateKey(isoDay);
  if (!isIsoDateOnly(key)) return new Date(NaN);
  return new Date(`${key}T12:00:00.000Z`);
}

export function parseCalendarDateInput(value: unknown): Date | null {
  const key = calendarDateKey(value);
  if (!isIsoDateOnly(key)) return null;
  return calendarDateAtUtcNoon(key);
}
