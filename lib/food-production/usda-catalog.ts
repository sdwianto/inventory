/**
 * Cadangan gizi USDA SR Legacy — subset gap-fill, bukan seluruh ~8790 baris Andrafarm.
 * Dipakai hanya jika bahan tidak ada di TKPI 2019. Nilai dari USDA SR resmi (bukan scrape).
 */

import type { NutritionFacts } from '@/lib/food-production/nutrition';
import { guessGramsPerUnit } from '@/lib/food-production/tkpi-parse';
import usdaFoodsJson from '@/data/usda/usda-foods.json';

export interface UsdaFoodRow {
  kode: string;
  ndb?: string;
  fdcId?: number;
  nama: string;
  namaId?: string;
  aliases?: string[];
  kelompok?: string;
  energiKcal: number;
  proteinG: number;
  lemakG: number;
  karbohidratG: number;
  seratG?: number;
  natriumMg?: number;
  bddPct: number;
}

export type UsdaMatchSuggestion = {
  kode: string;
  nama: string;
  namaId?: string;
  kelompok?: string;
  energiKcal: number;
  score: number;
  via: 'alias' | 'search';
};

let foodsCache: UsdaFoodRow[] | null = null;
let foodsByKode: Map<string, UsdaFoodRow> | null = null;

function normalizeUsdaKode(kode: string): string {
  const raw = String(kode || '').trim().toUpperCase();
  if (!raw) return '';
  if (raw.startsWith('USDA-')) return raw;
  if (/^\d{4,5}$/.test(raw)) return `USDA-${raw.padStart(5, '0')}`;
  return raw;
}

export function loadUsdaFoods(): UsdaFoodRow[] {
  if (foodsCache) return foodsCache;
  foodsCache = (usdaFoodsJson.items || []) as UsdaFoodRow[];
  foodsByKode = new Map(foodsCache.map((f) => [normalizeUsdaKode(f.kode), f]));
  return foodsCache;
}

export function getUsdaFood(kode: string): UsdaFoodRow | null {
  loadUsdaFoods();
  return foodsByKode?.get(normalizeUsdaKode(kode)) || null;
}

function haystack(row: UsdaFoodRow): string {
  return [
    row.kode,
    row.ndb,
    row.nama,
    row.namaId,
    row.kelompok,
    ...(row.aliases || []),
  ].filter(Boolean).join(' ').toLowerCase();
}

export function searchUsdaFoods(q: string, limit = 40): UsdaFoodRow[] {
  const needle = String(q || '').trim().toLowerCase();
  const cap = Math.min(100, Math.max(1, Number(limit) || 40));
  const all = loadUsdaFoods();
  if (!needle) return all.slice(0, cap);
  const hits = all.filter((row) => haystack(row).includes(needle));
  hits.sort((a, b) => {
    const an = (a.namaId || a.nama).toLowerCase();
    const bn = (b.namaId || b.nama).toLowerCase();
    const aStart = an.startsWith(needle) || (a.aliases || []).some((x) => x === needle) ? 0 : 1;
    const bStart = bn.startsWith(needle) || (b.aliases || []).some((x) => x === needle) ? 0 : 1;
    if (aStart !== bStart) return aStart - bStart;
    return an.localeCompare(bn, 'id');
  });
  return hits.slice(0, cap);
}

function aliasInNama(nama: string, alias: string): boolean {
  const a = alias.trim().toLowerCase();
  if (a.length < 3) return false;
  if (nama === a) return true;
  if (a.length >= 4) return nama.includes(a);
  return new RegExp(`(?:^|[^a-z0-9])${a}(?:$|[^a-z0-9])`, 'i').test(nama);
}

export function suggestUsdaMatches(nama: string, limit = 3): UsdaMatchSuggestion[] {
  const cap = Math.min(5, Math.max(1, Number(limit) || 3));
  const raw = String(nama || '').trim().toLowerCase();
  if (!raw) return [];
  const out: UsdaMatchSuggestion[] = [];
  const used = new Set<string>();

  for (const row of loadUsdaFoods()) {
    const aliases = (row.aliases || []).map((a) => a.toLowerCase());
    const hits = aliases.filter((a) => aliasInNama(raw, a));
    if (!hits.length) continue;
    hits.sort((a, b) => b.length - a.length);
    const hit = hits[0];
    const prefix = raw === hit || raw.startsWith(`${hit} `) || raw.startsWith(hit);
    out.push({
      kode: row.kode,
      nama: row.nama,
      namaId: row.namaId,
      kelompok: row.kelompok,
      energiKcal: row.energiKcal,
      score: (prefix ? 1000 : 800) + hit.length,
      via: 'alias',
    });
    used.add(row.kode);
  }

  if (!out.length) {
    for (const row of searchUsdaFoods(raw, 12)) {
      if (used.has(row.kode)) continue;
      out.push({
        kode: row.kode,
        nama: row.nama,
        namaId: row.namaId,
        kelompok: row.kelompok,
        energiKcal: row.energiKcal,
        score: 10,
        via: 'search',
      });
    }
  }

  out.sort((a, b) => b.score - a.score || a.nama.localeCompare(b.nama, 'id'));
  return out.slice(0, cap);
}

export function resolveUsdaCodeByProductName(nama: string): { kode: string; via: 'alias' | 'search' } | null {
  const hits = suggestUsdaMatches(nama, 3);
  if (hits.length === 1 && hits[0].via === 'alias') {
    return { kode: hits[0].kode, via: 'alias' };
  }
  if (hits.length >= 1 && hits[0].score >= 1000 && (!hits[1] || hits[1].score < hits[0].score)) {
    return { kode: hits[0].kode, via: hits[0].via };
  }
  return null;
}

export function nutritionFromUsdaCode(
  kode: string,
  satuan?: string | null,
  gramsPerUnit?: number | null,
): NutritionFacts | null {
  const row = getUsdaFood(kode);
  if (!row) return null;
  const g = Number(gramsPerUnit) > 0 ? Number(gramsPerUnit) : guessGramsPerUnit(satuan);
  return {
    basis: 'PER_100G',
    gramsPerUnit: g,
    bddPct: row.bddPct > 0 ? row.bddPct : 100,
    energiKcal: row.energiKcal,
    proteinG: row.proteinG,
    lemakG: row.lemakG,
    karbohidratG: row.karbohidratG,
    seratG: row.seratG || 0,
    natriumMg: row.natriumMg || 0,
    gulaG: 0,
    usdaCode: row.kode,
    usdaNama: row.namaId ? `${row.namaId} (${row.nama})` : row.nama,
  };
}
