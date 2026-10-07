import dpmJson from '@/data/tkpi/dpm-oil-absorption.json';

export const METODE_MASAK_VALUES = ['OTOMATIS', 'GORENG', 'TUMIS', 'TANPA_MINYAK'] as const;
export type MetodeMasak = (typeof METODE_MASAK_VALUES)[number];
type CookMethod = 'GORENG' | 'TUMIS';

export function parseMetodeMasak(raw: unknown): MetodeMasak | undefined {
  const v = String(raw ?? '').trim().toUpperCase();
  return (METODE_MASAK_VALUES as readonly string[]).includes(v) ? (v as MetodeMasak) : undefined;
}

/** Persen serapan manual per baris (1–100); kosong = otomatis. */
export function parseSerapPct(raw: unknown): number | undefined | { error: string } {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return { error: 'Serap % harus 0–100' };
  return Math.round(n * 100) / 100;
}

type GroupEntry = { pct: number; label: string; ref?: string };
type KeywordEntry = { match: string; group: string; pct: number; label: string };
const DPM = dpmJson as unknown as {
  fallbackPct: number;
  groups: Record<CookMethod, Record<string, GroupEntry>>;
  keywords: Record<CookMethod, KeywordEntry[]>;
  nameGroups: Array<{ match: string; group: string }>;
};
const NAME_GROUPS = DPM.nameGroups.map((g) => ({ re: new RegExp(`\\b(${g.match})`, 'i'), group: g.group }));

const GORENG_RE = /(goreng|krisp|crisp|kriuk|katsu|nugget|crunch|fried|karaage|karage|tempura|bakwan|perkedel|chips|keripik|rempeyek|peyek)/i;
const TUMIS_RE = /(tumis|oseng|\bcah\b|saut[eé]|stir[ -]?fr)/i;
/** Minyak bumbu/penyedap: ikut termakan penuh, bukan media menggoreng. */
const SEASONING_FAT_RE = /\b(wijen|sesame|zaitun|olive|mentega|butter|margarin|margarine)\b/i;
const NON_FRIED_RE = /\b(tepung|baking|pengembang|maizena|ragi|garam|gula|micin|penyedap|kaldu|saus|saos|kecap|mayo|mayones|mayonnaise|bumbu|merica|lada)\b/i;
const FAT_GROUPS = new Set(['K']);
const NON_FRIED_GROUPS = new Set(['K', 'N', 'M', 'J', 'Q']);

export interface OilItem {
  key: number;
  productNama?: string;
  tkpiCode?: string | null;
  tkpiNama?: string | null;
  /** Lemak per 100 g (dari data gizi). */
  lemakPer100?: number;
  /** Gram sebagaimana dipakai untuk hitung kontribusi gizi (ML/L dihitung 1 g/ml). */
  grams: number;
  /** Satuan dapur — volume dikoreksi berat jenis minyak. */
  satuan?: string;
  bddPct?: number;
  serapPct?: number;
}

export interface OilAbsorptionResult {
  /** Faktor pengali kontribusi gizi per baris minyak (key → 0..1, sudah termasuk berat jenis). */
  factorByKey: Map<number, number>;
  /** Persen terserap per baris minyak (key → 0..100). */
  serapPctByKey: Map<number, number>;
  /** Persen minyak goreng yang terserap (ditampilkan). */
  serapPct?: number;
  absorbedGrams: number;
  fryingOilGrams: number;
  method?: CookMethod | 'TANPA_MINYAK';
  manual: boolean;
  /** Dasar angka, mis. "DPM ikan goreng 20%" atau "cadangan 12%". */
  basis?: string;
}

const OIL_DENSITY = 0.92;

function groupOf(item: OilItem): string | undefined {
  const code = String(item.tkpiCode || '').trim().toUpperCase();
  if (/^[A-Z]{2}\d/.test(code)) return code[0];
  const nama = `${item.productNama || ''} ${item.tkpiNama || ''}`;
  return NAME_GROUPS.find((g) => g.re.test(nama))?.group;
}

function isFryingOil(item: OilItem): boolean {
  if (!(Number(item.lemakPer100) >= 99)) return false;
  return !SEASONING_FAT_RE.test(`${item.productNama || ''} ${item.tkpiNama || ''}`);
}

function realOilGrams(item: OilItem): number {
  const s = String(item.satuan || '').trim().toUpperCase();
  const isVolume = s === 'ML' || s === 'L' || s === 'LT' || s === 'LITER';
  return item.grams * (isVolume ? OIL_DENSITY : 1);
}

export function detectCookMethod(recipeNama: string | undefined, metode?: MetodeMasak): CookMethod | 'TANPA_MINYAK' | undefined {
  if (metode && metode !== 'OTOMATIS') return metode;
  const nama = String(recipeNama || '');
  if (GORENG_RE.test(nama)) return 'GORENG';
  if (TUMIS_RE.test(nama)) return 'TUMIS';
  return undefined;
}

function pctFor(item: OilItem, method: CookMethod): { pct: number; label: string } | null {
  const nama = `${item.productNama || ''} ${item.tkpiNama || ''}`.toLowerCase();
  const kw = DPM.keywords[method].find((k) => nama.includes(k.match));
  if (kw) return { pct: kw.pct, label: kw.label };
  const g = groupOf(item);
  if (!g) return null;
  const entry = DPM.groups[method][g];
  return entry ? { pct: entry.pct, label: entry.label } : null;
}

/**
 * Minyak goreng yang benar-benar termakan (DPM Kemenkes): % MT × berat mentah bersih bahan yang
 * digoreng/ditumis, maksimal sebanyak minyak di resep. Hanya untuk hitung gizi.
 */
export function estimateOilAbsorption(input: {
  recipeNama?: string;
  metodeMasak?: MetodeMasak;
  items: OilItem[];
}): OilAbsorptionResult {
  const oils = input.items.filter(isFryingOil);
  const factorByKey = new Map<number, number>();
  const serapPctByKey = new Map<number, number>();
  const empty: OilAbsorptionResult = { factorByKey, serapPctByKey, absorbedGrams: 0, fryingOilGrams: 0, manual: false };
  if (!oils.length) return empty;

  const fryingOilGrams = oils.reduce((s, o) => s + realOilGrams(o), 0);
  const manual = oils.filter((o) => o.serapPct != null);
  const method = detectCookMethod(input.recipeNama, input.metodeMasak);

  let autoPct: number;
  let basis: string;
  if (method === 'TANPA_MINYAK') {
    autoPct = 0;
    basis = 'cara masak tanpa minyak terserap';
  } else {
    const fried = input.items.filter((it) => {
      if (oils.includes(it) || !(it.grams > 0)) return false;
      const g = groupOf(it);
      if (g && (NON_FRIED_GROUPS.has(g) || FAT_GROUPS.has(g))) return false;
      return !NON_FRIED_RE.test(`${it.productNama || ''} ${it.tkpiNama || ''}`);
    });
    const netGrams = (it: OilItem) => it.grams * (Number(it.bddPct) > 0 && Number(it.bddPct) <= 100 ? Number(it.bddPct) / 100 : 1);
    let absorbed = 0;
    const labels = new Map<string, number>();
    if (method) {
      for (const it of fried) {
        const p = pctFor(it, method);
        if (!p) continue;
        absorbed += (netGrams(it) * p.pct) / 100;
        labels.set(`${p.label} ${p.pct}%`, (labels.get(`${p.label} ${p.pct}%`) || 0) + netGrams(it));
      }
    }
    if (absorbed > 0) {
      const main = [...labels.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
      basis = `DPM ${main.slice(0, 2).join(', ')}`;
    } else {
      const nonOil = input.items
        .filter((it) => !oils.includes(it) && !(Number(it.lemakPer100) >= 99))
        .reduce((s, it) => s + netGrams(it), 0);
      absorbed = (nonOil * DPM.fallbackPct) / 100;
      basis = `cadangan ${DPM.fallbackPct}% berat bahan`;
    }
    autoPct = fryingOilGrams > 0 ? Math.min(1, absorbed / fryingOilGrams) : 0;
  }

  let absorbedGrams = 0;
  for (const o of oils) {
    const real = realOilGrams(o);
    const frac = o.serapPct != null ? o.serapPct / 100 : autoPct;
    absorbedGrams += real * frac;
    factorByKey.set(o.key, o.grams > 0 ? (real * frac) / o.grams : 0);
    serapPctByKey.set(o.key, Math.round(frac * 1000) / 10);
  }
  const serapPct = fryingOilGrams > 0 ? Math.round((absorbedGrams / fryingOilGrams) * 1000) / 10 : undefined;
  return {
    factorByKey,
    serapPctByKey,
    serapPct,
    absorbedGrams,
    fryingOilGrams,
    method,
    manual: manual.length === oils.length,
    basis: manual.length === oils.length ? 'diisi manual' : basis,
  };
}
