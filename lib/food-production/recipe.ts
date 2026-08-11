/** Recipe master (Food BOM) — ADR-001 Sprint 2. */

import type { KategoriPorsi } from '@/lib/food-production/production-plan';

export const RECIPES_COLLECTION = 'recipes';

/** Default % untuk porsi kecil / balita relatif terhadap qty besar (100%). */
export const DEFAULT_PCT_KECIL = 70;

/** Kategori yang memakai qty besar (100%). */
export const KATEGORI_PORSI_BESAR_FAMILY = new Set<KategoriPorsi>([
  'PORSI_BESAR',
  'POSYANDU_BUMIL_BUSUI',
]);

/** Kategori yang memakai qty kecil (% dari besar). */
export const KATEGORI_PORSI_KECIL_FAMILY = new Set<KategoriPorsi>([
  'PORSI_KECIL',
  'POSYANDU_BALITA',
]);

export type RecipePorsiFamily = 'BESAR' | 'KECIL';

export function recipePorsiFamilyForKategori(
  kategori: string | undefined | null,
): RecipePorsiFamily {
  if (kategori && KATEGORI_PORSI_KECIL_FAMILY.has(kategori as KategoriPorsi)) {
    return 'KECIL';
  }
  return 'BESAR';
}

export interface RecipeLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  /** Alias qtyBesar — kompatibilitas data lama / nutrition / cost (qty dapur). */
  qty: number;
  /** Qty bahan dapur untuk porsi besar & bumil busui (100%). */
  qtyBesar: number;
  /** Persen qty kecil terhadap qty besar (1–100). */
  pctKecil: number;
  /** Derived: qtyBesar × pctKecil / 100 — porsi kecil & balita (qty dapur). */
  qtyKecil: number;
  /** Satuan dapur (boleh GR/ML; tidak harus = products.satuan). */
  satuan?: string;
  uomId?: string;
  /**
   * Qty dalam satuan basis produk (stok / pengadaan).
   * Diisi enrichLines lewat modul recipe-uom.
   */
  qtyBaseBesar?: number;
  qtyBaseKecil?: number;
  /** Snapshot: qtyBase = qtyDapur × factorToBase. */
  factorToBase?: number;
  /** Snapshot label products.satuan saat simpan. */
  baseSatuan?: string;
  notes?: string;
}

export function normalizeRecipeNama(value: unknown): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export interface RecipeDoc {
  id: string;
  tenantId: string;
  kode: string;
  /** Recipe identity (independent from product master). */
  nama: string;
  /**
   * Optional stock output product for hasil produksi.
   * Not required on recipe master — link later / at production if needed.
   */
  finishedGoodProductId?: string;
  finishedGoodKode?: string;
  finishedGoodNama?: string;
  version: number;
  effectiveDate: string;
  /** Yield in portions (porsi) per batch. */
  yieldQty: number;
  /** Optional waste % standard (0–100). */
  wastePct?: number;
  lines: RecipeLine[];
  catatan?: string;
  /** Optional recipe photo (stored via media API). */
  gambarUrl?: string;
  gambarMediaFile?: string;
  aktif: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function clampPctKecil(raw: unknown, fallback = DEFAULT_PCT_KECIL): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.round(n * 1000) / 1000));
}

export function computeQtyKecil(qtyBesar: number, pctKecil: number): number {
  const besar = Number(qtyBesar) || 0;
  const pct = clampPctKecil(pctKecil);
  return Math.round((besar * pct / 100 + Number.EPSILON) * 1e6) / 1e6;
}

/** Resolve dual-qty fields from legacy or new payload. */
export function resolveRecipeLineQtys(row: Record<string, unknown>): {
  qtyBesar: number;
  pctKecil: number;
  qtyKecil: number;
  qty: number;
} | { error: string } {
  const qtyBesarRaw = row.qtyBesar != null ? Number(row.qtyBesar) : Number(row.qty);
  if (!Number.isFinite(qtyBesarRaw) || qtyBesarRaw <= 0) {
    return { error: 'qty besar harus > 0' };
  }
  const pctKecil = row.pctKecil != null || row.pct_kecil != null
    ? clampPctKecil(row.pctKecil ?? row.pct_kecil)
    : DEFAULT_PCT_KECIL;
  const qtyKecil = row.qtyKecil != null && Number.isFinite(Number(row.qtyKecil))
    ? Math.round((Number(row.qtyKecil) + Number.EPSILON) * 1e6) / 1e6
    : computeQtyKecil(qtyBesarRaw, pctKecil);
  return {
    qtyBesar: qtyBesarRaw,
    pctKecil,
    qtyKecil,
    qty: qtyBesarRaw,
  };
}

export function recipeQtyForFamily(
  line: Pick<RecipeLine, 'qty' | 'qtyBesar' | 'qtyKecil' | 'pctKecil'>,
  family: RecipePorsiFamily,
): number {
  if (family === 'KECIL') {
    if (line.qtyKecil != null && Number.isFinite(Number(line.qtyKecil))) {
      return Number(line.qtyKecil) || 0;
    }
    const besar = Number(line.qtyBesar ?? line.qty) || 0;
    return computeQtyKecil(besar, line.pctKecil ?? DEFAULT_PCT_KECIL);
  }
  return Number(line.qtyBesar ?? line.qty) || 0;
}

export function recipeQtyForKategori(
  line: Pick<RecipeLine, 'qty' | 'qtyBesar' | 'qtyKecil' | 'pctKecil'>,
  kategori: string | undefined | null,
): number {
  return recipeQtyForFamily(line, recipePorsiFamilyForKategori(kategori));
}

/**
 * Split target porsi into besar/kecil families from selected categories.
 * Prefer acuan map; fallback: proportional by count of selected categories.
 */
export function splitPorsiByKategoriFamily(
  kategoriList: string[] | undefined | null,
  targetPorsi: number,
  acuanByKategori?: Partial<Record<string, number>> | null,
): { porsiBesar: number; porsiKecil: number } {
  const list = (kategoriList || []).filter(Boolean);
  const total = Math.max(0, Number(targetPorsi) || 0);
  if (!list.length) {
    return { porsiBesar: total, porsiKecil: 0 };
  }

  const besarCats = list.filter((k) => KATEGORI_PORSI_BESAR_FAMILY.has(k as KategoriPorsi));
  const kecilCats = list.filter((k) => KATEGORI_PORSI_KECIL_FAMILY.has(k as KategoriPorsi));

  if (acuanByKategori) {
    let porsiBesar = 0;
    let porsiKecil = 0;
    for (const k of besarCats) porsiBesar += Math.max(0, Number(acuanByKategori[k]) || 0);
    for (const k of kecilCats) porsiKecil += Math.max(0, Number(acuanByKategori[k]) || 0);
    const acuanTotal = porsiBesar + porsiKecil;
    if (acuanTotal > 0) {
      // If user overrode targetPorsi, scale families to match total.
      if (total > 0 && Math.abs(acuanTotal - total) > 0.0001) {
        const scale = total / acuanTotal;
        return {
          porsiBesar: Math.round((porsiBesar * scale + Number.EPSILON) * 1e4) / 1e4,
          porsiKecil: Math.round((porsiKecil * scale + Number.EPSILON) * 1e4) / 1e4,
        };
      }
      return { porsiBesar, porsiKecil };
    }
  }

  // Fallback: proportional by category count
  const nBesar = besarCats.length;
  const nKecil = kecilCats.length;
  const n = nBesar + nKecil || list.length;
  if (n === 0) return { porsiBesar: total, porsiKecil: 0 };
  if (nKecil === 0) return { porsiBesar: total, porsiKecil: 0 };
  if (nBesar === 0) return { porsiBesar: 0, porsiKecil: total };
  const porsiBesar = Math.round((total * (nBesar / n) + Number.EPSILON) * 1e4) / 1e4;
  const porsiKecil = Math.round((total - porsiBesar + Number.EPSILON) * 1e4) / 1e4;
  return { porsiBesar, porsiKecil };
}

function finalizeLineQtys(line: RecipeLine): RecipeLine {
  const qtyBesar = Number(line.qtyBesar ?? line.qty) || 0;
  const pctKecil = clampPctKecil(line.pctKecil);
  const qtyKecil = computeQtyKecil(qtyBesar, pctKecil);
  return {
    ...line,
    qty: qtyBesar,
    qtyBesar,
    pctKecil,
    qtyKecil,
  };
}

/** Merge lines with the same productId — sum qty besar, keep first satuan/notes; pct weighted avg. */
export function consolidateRecipeLines(lines: RecipeLine[]): RecipeLine[] {
  const byId = new Map<string, RecipeLine>();
  for (const line of lines) {
    const productId = String(line.productId || '').trim();
    if (!productId) continue;
    const normalized = finalizeLineQtys({ ...line, productId });
    const existing = byId.get(productId);
    if (!existing) {
      byId.set(productId, normalized);
      continue;
    }
    const sumBesar = (Number(existing.qtyBesar) || 0) + (Number(normalized.qtyBesar) || 0);
    // Weighted average pct by qtyBesar contribution
    const w1 = Number(existing.qtyBesar) || 0;
    const w2 = Number(normalized.qtyBesar) || 0;
    const pct = (w1 + w2) > 0
      ? ((Number(existing.pctKecil) || DEFAULT_PCT_KECIL) * w1
        + (Number(normalized.pctKecil) || DEFAULT_PCT_KECIL) * w2) / (w1 + w2)
      : DEFAULT_PCT_KECIL;
    existing.qtyBesar = sumBesar;
    existing.qty = sumBesar;
    existing.pctKecil = clampPctKecil(pct);
    existing.qtyKecil = computeQtyKecil(sumBesar, existing.pctKecil);
    // qtyBase* harus dihitung ulang lewat enrichLines (faktor bisa beda antar baris).
    delete existing.qtyBaseBesar;
    delete existing.qtyBaseKecil;
    delete existing.factorToBase;
    delete existing.baseSatuan;
    if (!existing.satuan && normalized.satuan) existing.satuan = normalized.satuan;
    if (!existing.uomId && normalized.uomId) existing.uomId = normalized.uomId;
    if (!existing.productKode && normalized.productKode) existing.productKode = normalized.productKode;
    if (!existing.productNama && normalized.productNama) existing.productNama = normalized.productNama;
    if (normalized.notes) {
      const a = String(existing.notes || '').trim();
      const b = String(normalized.notes).trim();
      if (b && a !== b) existing.notes = a ? `${a}; ${b}` : b;
    }
  }
  return [...byId.values()];
}

export function normalizeRecipeLines(
  raw: unknown,
  options?: { finishedGoodProductId?: string },
): RecipeLine[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Resep wajib punya minimal 1 baris bahan' };
  }
  const lines: RecipeLine[] = [];
  const fgId = options?.finishedGoodProductId?.trim() || '';
  const satuanByProduct = new Map<string, string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const productId = String(row?.productId || '').trim();
    if (!productId) return { error: `Baris ${i + 1}: productId wajib` };
    const qtys = resolveRecipeLineQtys(row);
    if ('error' in qtys) return { error: `Baris ${i + 1}: ${qtys.error}` };
    if (fgId && productId === fgId) {
      return { error: `Baris ${i + 1}: barang jadi tidak boleh jadi bahan di resep yang sama` };
    }
    const satuan = row.satuan != null ? String(row.satuan).trim().toUpperCase() : '';
    if (satuan) {
      const prev = satuanByProduct.get(productId);
      if (prev && prev !== satuan) {
        return {
          error: `Baris ${i + 1}: produk yang sama tidak boleh memakai satuan dapur berbeda (${prev} vs ${satuan})`,
        };
      }
      satuanByProduct.set(productId, satuan);
    }
    lines.push({
      productId,
      productKode: row.productKode != null ? String(row.productKode) : undefined,
      productNama: row.productNama != null ? String(row.productNama) : undefined,
      qty: qtys.qty,
      qtyBesar: qtys.qtyBesar,
      pctKecil: qtys.pctKecil,
      qtyKecil: qtys.qtyKecil,
      satuan: row.satuan != null ? String(row.satuan) : undefined,
      uomId: row.uomId != null ? String(row.uomId) : undefined,
      notes: row.notes != null ? String(row.notes).trim() || undefined : undefined,
    });
  }
  const merged = consolidateRecipeLines(lines);
  if (!merged.length) return { error: 'Resep wajib punya minimal 1 baris bahan' };
  for (const line of merged) {
    if (!(line.qtyBesar > 0)) {
      return { error: `Qty besar bahan ${line.productNama || line.productId} harus > 0` };
    }
  }
  return merged;
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
