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

export function resolveTkpiCodeByProductName(nama: string): { kode: string; via: 'alias' | 'search' } | null {
  const raw = String(nama || '').trim();
  if (!raw) return null;
  for (const a of TKPI_PRODUCT_ALIASES) {
    if (a.match.test(raw)) return { kode: a.kode, via: 'alias' };
  }

  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !NAME_STOP.has(t));
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
  const all = loadTkpiFoods();
  if (!needle) return all.slice(0, limit);
  const out: TkpiFoodRow[] = [];
  for (const row of all) {
    const hay = `${row.kode} ${row.nama} ${row.kelompok || ''}`.toLowerCase();
    if (hay.includes(needle)) {
      out.push(row);
      if (out.length >= limit) break;
    }
  }
  return out;
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
