/**
 * Kebutuhan bahan harian — Fase 2 acuan kerja dapur.
 * Wrap recipeIngredientNeeds: per hidangan + rekap SKU (buffer 3%, alergi ekstra).
 */

import { ceilProcurementQty, roundQty } from '@/lib/food-production/material-requirement';
import { normalizeRecipeSatuan } from '@/lib/food-production/recipe-uom';
import {
  KATEGORI_MENU_OPTIONS,
  isKategoriMenu,
  kategoriMenuLabel,
  type KategoriMenu,
  type RecipeDoc,
} from '@/lib/food-production/recipe';
import {
  RECIPE_NEED_BUFFER_PCT,
  getRecipeBufferPct,
  type ProductionPlanLine,
} from '@/lib/food-production/production-plan';
import {
  alergiKategoriPorsi,
  porsiKategoriWithQty,
  slotRecipeIds,
  type WeeklyMenuDay,
  type WeeklyRecipeRef,
} from '@/lib/food-production/weekly-menu-plan';
import {
  recipeIngredientNeeds,
  type RecipeIngredientNeedRow,
} from '@/lib/food-production/rencana-kebutuhan';
import {
  emptyPortionTargets,
  sumAllPorsi,
  type PortionTargetMap,
} from '@/lib/food-production/portion-target';

export type KebutuhanRecipeRef = WeeklyRecipeRef & {
  yieldQty?: number;
  wastePct?: number;
  nama?: string;
  lines?: RecipeDoc['lines'];
};

export type KebutuhanBahanHidangan = {
  recipeId: string;
  recipeKode?: string;
  recipeNama?: string;
  slot?: KategoriMenu | 'ALERGI';
  slotLabel: string;
  targetPorsi: number;
  yieldQty?: number;
  notes?: string;
  isAlergi?: boolean;
  lines: RecipeIngredientNeedRow[];
  error?: string;
};

export type KebutuhanBahanRekapLine = {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  qty: number;
  qtyExact: number;
  sources: Array<{ recipeKode?: string; recipeNama?: string; qty: number }>;
};

export type KebutuhanBahanHarian = {
  hidangan: KebutuhanBahanHidangan[];
  rekap: KebutuhanBahanRekapLine[];
  errors: string[];
};

export type KebutuhanHidanganInput = {
  recipeId: string;
  recipeKode?: string;
  recipeNama?: string;
  slot?: KategoriMenu | 'ALERGI';
  slotLabel: string;
  targetPorsi: number;
  kategoriPorsiList: string[];
  notes?: string;
  isAlergi?: boolean;
};

function recipeBufferPct(
  recipeId: string,
  map?: Record<string, number> | null,
): number {
  const fromMap = getRecipeBufferPct(map, recipeId);
  return fromMap > 0 ? fromMap : RECIPE_NEED_BUFFER_PCT;
}

function explodeHidangan(
  row: KebutuhanHidanganInput,
  recipe: KebutuhanRecipeRef | undefined,
  acuan: PortionTargetMap,
  bufferMap?: Record<string, number> | null,
): KebutuhanBahanHidangan {
  const base: KebutuhanBahanHidangan = {
    recipeId: row.recipeId,
    recipeKode: row.recipeKode || recipe?.kode,
    recipeNama: row.recipeNama || recipe?.nama,
    slot: row.slot,
    slotLabel: row.slotLabel,
    targetPorsi: row.targetPorsi,
    yieldQty: Number(recipe?.yieldQty) > 0 ? Number(recipe?.yieldQty) : undefined,
    notes: row.notes,
    isAlergi: row.isAlergi,
    lines: [],
  };
  if (!recipe) {
    return { ...base, error: `Resep ${row.recipeId} tidak ditemukan` };
  }
  if (!recipe.lines?.length) {
    return { ...base, error: `Resep ${recipe.kode || row.recipeId} belum punya bahan` };
  }
  if (!(Number(row.targetPorsi) > 0)) {
    return { ...base, error: 'Target porsi 0 — isi penerima manfaat' };
  }
  const lines = recipeIngredientNeeds({
    recipe,
    menuTargetPorsi: row.targetPorsi,
    recipePerMenuPorsi: 1,
    kategoriPorsiList: row.kategoriPorsiList,
    acuanByKategori: acuan,
    bufferPct: recipeBufferPct(row.recipeId, bufferMap),
  });
  return { ...base, lines };
}

function aggregateRekap(hidangan: KebutuhanBahanHidangan[]): KebutuhanBahanRekapLine[] {
  const acc = new Map<string, KebutuhanBahanRekapLine>();
  for (const dish of hidangan) {
    for (const line of dish.lines) {
      const satKey = normalizeRecipeSatuan(line.satuan) || String(line.satuan || '');
      const key = `${line.productId}::${satKey}`;
      const exact = roundQty((Number(line.qtyBesarPart) || 0) + (Number(line.qtyKecilPart) || 0));
      if (!(exact > 0)) continue;
      const prev = acc.get(key) || {
        productId: line.productId,
        productKode: line.productKode,
        productNama: line.productNama,
        satuan: line.satuan,
        qty: 0,
        qtyExact: 0,
        sources: [],
      };
      prev.qtyExact = roundQty(prev.qtyExact + exact);
      prev.productKode = prev.productKode || line.productKode;
      prev.productNama = prev.productNama || line.productNama;
      prev.satuan = prev.satuan || line.satuan;
      prev.sources.push({
        recipeKode: dish.recipeKode,
        recipeNama: dish.recipeNama,
        qty: exact,
      });
      acc.set(key, prev);
    }
  }
  return [...acc.values()]
    .map((row) => ({
      ...row,
      qty: ceilProcurementQty(row.qtyExact, row.satuan),
    }))
    .filter((row) => row.qty > 0)
    .sort((a, b) =>
      String(a.productNama || a.productKode || a.productId)
        .localeCompare(String(b.productNama || b.productKode || b.productId), 'id'),
    );
}

export function hidanganInputFromWeeklyDay(
  day: Pick<WeeklyMenuDay, 'porsiByKategori' | 'slots' | 'alergi'>,
  recipesById: Map<string, KebutuhanRecipeRef>,
): KebutuhanHidanganInput[] {
  const acuan = day.porsiByKategori || emptyPortionTargets();
  const total = sumAllPorsi(acuan);
  const kpList = porsiKategoriWithQty(acuan);
  const kategoriPorsiList = kpList.length ? kpList : ['PORSI_BESAR'];
  const out: KebutuhanHidanganInput[] = [];
  for (const opt of KATEGORI_MENU_OPTIONS) {
    for (const recipeId of day.slots?.[opt.value] || []) {
      const recipe = recipesById.get(recipeId);
      out.push({
        recipeId,
        recipeKode: recipe?.kode,
        recipeNama: recipe?.nama,
        slot: opt.value,
        slotLabel: opt.label,
        targetPorsi: total,
        kategoriPorsiList,
      });
    }
  }
  const alergiKp = [alergiKategoriPorsi(acuan)];
  for (const row of day.alergi || []) {
    const recipe = recipesById.get(row.recipeId);
    out.push({
      recipeId: row.recipeId,
      recipeKode: recipe?.kode,
      recipeNama: recipe?.nama,
      slot: 'ALERGI',
      slotLabel: 'Alergi',
      targetPorsi: Number(row.porsi) || 0,
      kategoriPorsiList: alergiKp,
      notes: row.catatan ? `ALERGI: ${row.catatan}` : 'ALERGI',
      isAlergi: true,
    });
  }
  return out;
}

export function hidanganInputFromPlanLines(
  lines: Array<Pick<ProductionPlanLine, 'recipeId' | 'recipeKode' | 'recipeNama' | 'targetPorsi' | 'kategoriPorsiList' | 'notes'>>,
  recipesById: Map<string, KebutuhanRecipeRef>,
  fallbackKategoriPorsiList: string[],
): KebutuhanHidanganInput[] {
  const fallback = fallbackKategoriPorsiList.length ? fallbackKategoriPorsiList : ['PORSI_BESAR'];
  const out: KebutuhanHidanganInput[] = [];
  for (const line of lines) {
    const recipeId = String(line.recipeId || '').trim();
    if (!recipeId) continue;
    const recipe = recipesById.get(recipeId);
    const notes = String(line.notes || '').trim();
    const isAlergi = /^alergi\b/i.test(notes);
    const kp = (line.kategoriPorsiList && line.kategoriPorsiList.length)
      ? line.kategoriPorsiList.map(String)
      : fallback;
    const slot: KebutuhanHidanganInput['slot'] = isAlergi
      ? 'ALERGI'
      : (recipe?.kategoriMenu && isKategoriMenu(recipe.kategoriMenu) ? recipe.kategoriMenu : undefined);
    const slotLabel = isAlergi
      ? 'Alergi'
      : (slot ? kategoriMenuLabel(slot) : 'Hidangan');
    out.push({
      recipeId,
      recipeKode: line.recipeKode || recipe?.kode,
      recipeNama: line.recipeNama || recipe?.nama,
      slot,
      slotLabel,
      targetPorsi: Number(line.targetPorsi) || 0,
      kategoriPorsiList: kp,
      notes: notes || undefined,
      isAlergi,
    });
  }
  return out;
}

export function buildKebutuhanBahanHarian(input: {
  hidangan: KebutuhanHidanganInput[];
  recipesById: Map<string, KebutuhanRecipeRef>;
  acuanByKategori: PortionTargetMap;
  recipeBufferPct?: Record<string, number> | null;
}): KebutuhanBahanHarian {
  const errors: string[] = [];
  const hidangan = input.hidangan.map((row) => {
    const dish = explodeHidangan(
      row,
      input.recipesById.get(row.recipeId),
      input.acuanByKategori,
      input.recipeBufferPct,
    );
    if (dish.error) errors.push(dish.error);
    return dish;
  });
  return {
    hidangan,
    rekap: aggregateRekap(hidangan),
    errors: [...new Set(errors)],
  };
}

export function buildKebutuhanBahanFromWeeklyDay(
  day: Pick<WeeklyMenuDay, 'porsiByKategori' | 'slots' | 'alergi'>,
  recipesById: Map<string, KebutuhanRecipeRef>,
  recipeBufferPct?: Record<string, number> | null,
): KebutuhanBahanHarian {
  const acuan = { ...emptyPortionTargets(), ...(day.porsiByKategori || {}) };
  return buildKebutuhanBahanHarian({
    hidangan: hidanganInputFromWeeklyDay({ ...day, porsiByKategori: acuan }, recipesById),
    recipesById,
    acuanByKategori: acuan,
    recipeBufferPct,
  });
}

export function acuanKerjaFileName(
  kitchenNama: string | undefined,
  tanggal: string,
  kind: 'acuan' | 'bahan' = 'acuan',
): string {
  const raw = String(kitchenNama || 'Dapur').trim() || 'Dapur';
  const dapur = raw.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'Dapur';
  const tgl = String(tanggal || '').slice(0, 10) || 'tanggal';
  const prefix = kind === 'bahan' ? 'Kebutuhan-Bahan' : 'Acuan-Kerja';
  return `${prefix}-${dapur}-${tgl}`;
}

export function acuanKerjaDraftWatermark(
  productionPlanNo?: string | null,
  status?: string | null,
): boolean {
  if (!String(productionPlanNo || '').trim()) return true;
  const st = String(status || '').trim();
  return !st || st === 'DRAFT';
}

/** Dipakai tes rumus Excel: 500 g × porsi / yield × 1,03. */
export function formulaQtyWithBuffer(input: {
  qtyResep: number;
  porsi: number;
  yieldQty: number;
  bufferPct?: number;
}): number {
  const y = Number(input.yieldQty) > 0 ? Number(input.yieldQty) : 1;
  const buffer = Number(input.bufferPct);
  const pct = Number.isFinite(buffer) && buffer > 0 ? buffer : RECIPE_NEED_BUFFER_PCT;
  return Number(input.qtyResep) * (Number(input.porsi) / y) * (1 + pct / 100);
}

export function dayHasHidangan(day: Pick<WeeklyMenuDay, 'slots' | 'alergi'>): boolean {
  return slotRecipeIds(day.slots).length > 0 || (day.alergi || []).length > 0;
}
