/**
 * Infer isi netto kemasan dari nama produk (label: 1kg, 150g, 600ml, 5,7L, 1/2kg).
 * Infer dilewati untuk SKU operasional (bukan bahan resep).
 */

export type PackNetInfer = {
  grams: number | null;
  ml: number | null;
};

const MASS_UNITS = new Set(['G', 'GR', 'GRAM', 'KG', 'KILOGRAM']);
const VOLUME_UNITS = new Set(['ML', 'MILILITER', 'MILLILITER', 'L', 'LT', 'LTR', 'LITER']);

/** Number + unit di nama. Unit panjang dulu agar "kg" tidak terpotong jadi "g". */
const PACK_NET_RE =
  /(\d+(?:[.,]\d+)*)\s*(kilogram|kg|gram|gr|g|mililiter|milliliter|ml|liter|ltr|lt|l)\b/gi;

/** Pecahan 1/2kg, 1/4 L, dst. */
const PACK_NET_FRACTION_RE =
  /(\d+)\s*\/\s*(\d+)\s*(kilogram|kg|gram|gr|g|mililiter|milliliter|ml|liter|ltr|lt|l)\b/gi;

/** Bukan bahan resep — satuan dapur tetap as-is (jangan infer GR/ML dari nama). */
export const RECIPE_INFER_SKIP_KODES = new Set([
  'B189497',
  'B212248',
  'B184082',
  'B446012',
  'B371513',
  'B642256',
  'B227962',
  'B509748',
  'B443745',
  'B655313',
]);

export function shouldSkipRecipeNameInfer(kode?: string | null, nama?: string | null): boolean {
  const k = String(kode || '').trim().toUpperCase();
  if (k && RECIPE_INFER_SKIP_KODES.has(k)) return true;
  const n = String(nama || '').toLowerCase();
  return n.includes('joyoboyo') && n.includes('plastik');
}

function parseLocaleNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  if (s.includes(',') && s.includes('.')) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      const n = Number(s.replace(/\./g, '').replace(',', '.'));
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  if (s.includes(',')) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      const n = Number(`${parts[0]}.${parts[1]}`);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    if (parts.length === 2 && parts[1].length === 3) {
      const n = Number(parts.join(''));
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  if (s.includes('.')) {
    const parts = s.split('.');
    if (parts.length > 2) {
      const n = Number(parts.join(''));
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    if (parts.length === 2 && parts[1].length === 3) {
      const n = Number(parts.join(''));
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toGrams(qty: number, unit: string): number | null {
  if (unit === 'KG' || unit === 'KILOGRAM') return qty * 1000;
  if (unit === 'G' || unit === 'GR' || unit === 'GRAM') return qty;
  return null;
}

function toMl(qty: number, unit: string): number | null {
  if (unit === 'L' || unit === 'LT' || unit === 'LTR' || unit === 'LITER') return qty * 1000;
  if (unit === 'ML' || unit === 'MILILITER' || unit === 'MILLILITER') return qty;
  return null;
}

function uniquePositive(values: number[]): number | null {
  if (values.length === 0) return null;
  const first = values[0];
  if (!values.every((v) => Math.abs(v - first) < 1e-9)) return null;
  return first;
}

function pushByUnit(qty: number, unit: string, mass: number[], volume: number[]): void {
  if (MASS_UNITS.has(unit)) {
    const grams = toGrams(qty, unit);
    if (grams != null && grams > 0) mass.push(grams);
  } else if (VOLUME_UNITS.has(unit)) {
    const ml = toMl(qty, unit);
    if (ml != null && ml > 0) volume.push(ml);
  }
}

function coveredByFraction(index: number, spans: Array<{ start: number; end: number }>): boolean {
  return spans.some((s) => index >= s.start && index < s.end);
}

/**
 * Parse isi netto dari nama. Ambigu (massa+volume, atau dua nilai beda) → null, null.
 */
export function parsePackNetFromNama(nama: unknown): PackNetInfer {
  const text = String(nama || '').trim();
  if (!text) return { grams: null, ml: null };

  const mass: number[] = [];
  const volume: number[] = [];
  const fractionSpans: Array<{ start: number; end: number }> = [];

  const fracRe = new RegExp(PACK_NET_FRACTION_RE.source, PACK_NET_FRACTION_RE.flags);
  let fm: RegExpExecArray | null;
  while ((fm = fracRe.exec(text)) != null) {
    const num = Number(fm[1]);
    const den = Number(fm[2]);
    const unit = String(fm[3] || '').toUpperCase();
    if (!(num > 0) || !(den > 0)) continue;
    fractionSpans.push({ start: fm.index, end: fm.index + fm[0].length });
    pushByUnit(num / den, unit, mass, volume);
  }

  const re = new RegExp(PACK_NET_RE.source, PACK_NET_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    if (coveredByFraction(m.index, fractionSpans)) continue;
    if (m.index > 0 && text[m.index - 1] === '/') continue;
    const qty = parseLocaleNumber(m[1] || '');
    const unit = String(m[2] || '').toUpperCase();
    if (!(qty != null && qty > 0)) continue;
    pushByUnit(qty, unit, mass, volume);
  }

  const grams = uniquePositive(mass);
  const ml = uniquePositive(volume);
  if (grams != null && ml != null) return { grams: null, ml: null };
  if (grams == null && ml == null) return { grams: null, ml: null };
  return { grams, ml };
}

export function positiveOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
