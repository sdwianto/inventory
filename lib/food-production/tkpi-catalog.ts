/**
 * Load seeded TKPI foods + AKG MBG meal profiles (JSON bundle).
 * TKPI: scripts/build-tkpi-seed.mjs ← TKPI.csv
 * AKG: data/tkpi/akg-profiles.json (Tabel 2 satu kali MBG; bukan CSV AKG Sehari)
 */

import type { NutritionTotals, NutritionFacts } from '@/lib/food-production/nutrition';
import type { TkpiFoodRow, AkgProfileSeed } from '@/lib/food-production/tkpi-parse';
import { tkpiToNutritionFacts, guessGramsPerUnit } from '@/lib/food-production/tkpi-parse';
import tkpiFoodsJson from '@/data/tkpi/tkpi-foods.json';
import akgProfilesJson from '@/data/tkpi/akg-profiles.json';

export type { TkpiFoodRow, AkgProfileSeed };

/** Alias nama dagang inventori / sales.app → kode TKPI (urutan spesifik dulu). */
export const TKPI_PRODUCT_ALIASES: Array<{ match: RegExp; kode: string }> = [
  { match: /beras\s*pulen/i, kode: 'AR001' },
  { match: /beras\s*giling/i, kode: 'AR001' },
  { match: /telur\s*ayam\s*(broiler|ras)/i, kode: 'HR002' },
  { match: /bawang\s*bombay/i, kode: 'DR007' },
  { match: /bawang\s*putih/i, kode: 'NR008' },
  { match: /bawang\s*merah/i, kode: 'NR007' },
  { match: /\bkangkung\b/i, kode: 'DR100' },
];

const NAME_STOP = new Set([
  'dan', 'atau', 'dengan', 'untuk', 'kupas', 'segar', 'mentah', 'kering',
  'pack', 'pcs', 'buah', 'ikat', 'bal', 'kg', 'gram', 'gr', 'ml', 'liter',
]);

export type TkpiResolveVia = 'code' | 'alias' | 'search';

export type TkpiMatchSuggestion = {
  kode: string;
  nama: string;
  kelompok?: string;
  energiKcal: number;
  score: number;
  via: 'alias' | 'search';
};

function tokenizeProductNama(nama: string): string[] {
  return String(nama || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !NAME_STOP.has(t) && !/^[a-z]{0,3}\d{4,}$/.test(t));
}

/** Awalan kategori dagang — bukan nama bahan gizi. */
const PICKER_GENERIC_PREFIX = new Set(['rempah', 'bumbu']);

/** Token pencarian dialog gizi (Jagung manis → jagung; Rempah Kayu Manis → kayu manis). */
export function tkpiPickerQuery(nama: string): string {
  const tokens = tokenizeProductNama(nama);
  let start = 0;
  while (start < tokens.length && PICKER_GENERIC_PREFIX.has(tokens[start])) start += 1;
  const useful = start > 0 ? tokens.slice(start) : tokens;
  if (start > 0 && useful.length >= 2) return useful.join(' ');
  if (useful[0]) return useful[0];
  const first = String(nama || '').trim().toLowerCase().split(/\s+/).find((t) => t.length > 1);
  return first || '';
}

function scoreTkpiNama(tkpiNama: string, tokens: string[]): number {
  if (!tokens.length) return 0;
  const hay = tkpiNama.toLowerCase();
  const first = tokens[0];
  if (!hay.includes(first)) return 0;
  let score = 5;
  if (hay.startsWith(first)) score += 10;
  const extra = tokens.slice(1);
  const extraInName = extra.filter((t) => hay.includes(t));
  if (extra.length && extraInName.length === extra.length) score += 20;
  else score += extraInName.length * 4;
  const extrasAreBrand = extra.length > 0 && extraInName.length === 0;
  const genericSegar = hay === `${first}, segar` || hay === first;
  if (genericSegar) score += extrasAreBrand || extra.length === 0 ? 15 : 8;
  return score;
}

/**
 * Top-N TKPI suggestions for review Excel (ties allowed).
 * Tidak menulis DB — beda dengan resolveTkpiCodeByProductName yang menolak seri.
 */
export function suggestTkpiMatches(nama: string, limit = 3): TkpiMatchSuggestion[] {
  const cap = Math.min(5, Math.max(1, Number(limit) || 3));
  const raw = String(nama || '').trim();
  if (!raw) return [];

  const out: TkpiMatchSuggestion[] = [];
  const used = new Set<string>();

  for (const a of TKPI_PRODUCT_ALIASES) {
    if (!a.match.test(raw)) continue;
    const row = getTkpiFood(a.kode);
    if (!row) continue;
    out.push({
      kode: row.kode,
      nama: row.nama,
      kelompok: row.kelompok,
      energiKcal: row.energiKcal,
      score: 1000,
      via: 'alias',
    });
    used.add(row.kode.toUpperCase());
    break;
  }

  const tokens = tokenizeProductNama(raw);
  if (tokens.length) {
    const first = tokens[0];
    const scored: TkpiMatchSuggestion[] = [];
    for (const row of loadTkpiFoods()) {
      if (used.has(row.kode.toUpperCase())) continue;
      const hay = `${row.kode} ${row.nama}`.toLowerCase();
      if (!hay.includes(first)) continue;
      const score = scoreTkpiNama(row.nama, tokens);
      if (score < 5) continue;
      scored.push({
        kode: row.kode,
        nama: row.nama,
        kelompok: row.kelompok,
        energiKcal: row.energiKcal,
        score,
        via: 'search',
      });
    }
    scored.sort((a, b) => b.score - a.score || a.nama.localeCompare(b.nama, 'id'));
    for (const hit of scored) {
      if (out.length >= cap) break;
      out.push(hit);
    }
  }

  return out.slice(0, cap);
}

export function resolveTkpiCodeByProductName(nama: string): { kode: string; via: 'alias' | 'search' } | null {
  const raw = String(nama || '').trim();
  if (!raw) return null;
  for (const a of TKPI_PRODUCT_ALIASES) {
    if (a.match.test(raw)) return { kode: a.kode, via: 'alias' };
  }

  const tokens = tokenizeProductNama(raw);
  if (!tokens.length) return null;

  // Coba frasa bertingkat: full → tanpa token terakhir
  const queries = [tokens.join(' ')];
  if (tokens.length > 1) queries.push(tokens.slice(0, 2).join(' '), tokens[0]);

  for (const q of queries) {
    const hits = searchTkpiFoods(q, 12);
    if (!hits.length) continue;
    const qTokens = q.split(/\s+/);
    const scored = hits.map((h) => {
      const hay = h.nama.toLowerCase();
      const allIn = qTokens.every((t) => hay.includes(t));
      const starts = hay.startsWith(qTokens[0]);
      return { h, score: (allIn ? 10 : 0) + (starts ? 3 : 0) + (hay.includes(q) ? 5 : 0) };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];
    if (best && best.score >= 10 && (!second || best.score > second.score)) {
      return { kode: best.h.kode, via: 'search' };
    }
  }
  return null;
}

export function isAmbiguousSatuan(satuan?: string | null): boolean {
  const s = String(satuan || '').trim().toUpperCase();
  return s === 'PACK' || s === 'PCS' || s === 'BUAH' || s === 'IKAT' || s === 'BAL' || s === 'BUNGKUS';
}

let foodsCache: TkpiFoodRow[] | null = null;
let foodsByKode: Map<string, TkpiFoodRow> | null = null;

export function loadTkpiFoods(): TkpiFoodRow[] {
  if (foodsCache) return foodsCache;
  foodsCache = (tkpiFoodsJson.items || []) as TkpiFoodRow[];
  foodsByKode = new Map(foodsCache.map((f) => [f.kode.toUpperCase(), f]));
  return foodsCache;
}

export function loadAkgProfileSeeds(): AkgProfileSeed[] {
  return (akgProfilesJson.profiles || []) as AkgProfileSeed[];
}

export function getTkpiFood(kode: string): TkpiFoodRow | null {
  loadTkpiFoods();
  return foodsByKode?.get(String(kode || '').trim().toUpperCase()) || null;
}

export function searchTkpiFoods(q: string, limit = 40): TkpiFoodRow[] {
  const needle = String(q || '').trim().toLowerCase();
  const cap = Math.min(100, Math.max(1, Number(limit) || 40));
  const all = loadTkpiFoods();
  if (!needle) return all.slice(0, cap);
  const hits = all.filter((row) => {
    const hay = `${row.kode} ${row.nama} ${row.kelompok || ''}`.toLowerCase();
    return hay.includes(needle);
  });
  hits.sort((a, b) => {
    const an = a.nama.toLowerCase();
    const bn = b.nama.toLowerCase();
    const aStart = an.startsWith(needle) ? 0 : 1;
    const bStart = bn.startsWith(needle) ? 0 : 1;
    if (aStart !== bStart) return aStart - bStart;
    return an.localeCompare(bn, 'id');
  });
  return hits.slice(0, cap);
}

export function akgProfilesRecord(): Record<string, NutritionTotals> {
  const out: Record<string, NutritionTotals> = {};
  for (const p of loadAkgProfileSeeds()) {
    out[p.key] = {
      energiKcal: p.energiKcal,
      proteinG: p.proteinG,
      lemakG: p.lemakG,
      karbohidratG: p.karbohidratG,
      seratG: p.seratG,
      natriumMg: p.natriumMg,
      gulaG: p.gulaG,
    };
  }
  return out;
}

export function akgProfileMeta(): Array<{ key: string; label: string }> {
  return loadAkgProfileSeeds()
    .filter((p) => p.key === 'PORSI_KECIL' || p.key === 'PORSI_BESAR')
    .map((p) => ({ key: p.key, label: p.label }));
}

export function nutritionFromTkpiCode(
  kode: string,
  satuan?: string | null,
  gramsPerUnit?: number | null,
): NutritionFacts | null {
  const row = getTkpiFood(kode);
  if (!row) return null;
  const g = Number(gramsPerUnit) > 0 ? Number(gramsPerUnit) : guessGramsPerUnit(satuan);
  return tkpiToNutritionFacts(row, g) as NutritionFacts;
}
