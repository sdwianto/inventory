/** Recipe master (Food BOM) — ADR-001 Sprint 2. */

export const RECIPES_COLLECTION = 'recipes';

export interface RecipeLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  qty: number;
  satuan?: string;
  uomId?: string;
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

/** Merge lines with the same productId — sum qty, keep first satuan/notes. */
export function consolidateRecipeLines(lines: RecipeLine[]): RecipeLine[] {
  const byId = new Map<string, RecipeLine>();
  for (const line of lines) {
    const productId = String(line.productId || '').trim();
    if (!productId) continue;
    const existing = byId.get(productId);
    if (!existing) {
      byId.set(productId, { ...line, productId, qty: Number(line.qty) || 0 });
      continue;
    }
    existing.qty = (Number(existing.qty) || 0) + (Number(line.qty) || 0);
    if (!existing.satuan && line.satuan) existing.satuan = line.satuan;
    if (!existing.uomId && line.uomId) existing.uomId = line.uomId;
    if (!existing.productKode && line.productKode) existing.productKode = line.productKode;
    if (!existing.productNama && line.productNama) existing.productNama = line.productNama;
    if (line.notes) {
      const a = String(existing.notes || '').trim();
      const b = String(line.notes).trim();
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
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const productId = String(row?.productId || '').trim();
    const qty = Number(row?.qty);
    if (!productId) return { error: `Baris ${i + 1}: productId wajib` };
    if (!Number.isFinite(qty) || qty <= 0) return { error: `Baris ${i + 1}: qty harus > 0` };
    if (fgId && productId === fgId) {
      return { error: `Baris ${i + 1}: barang jadi tidak boleh jadi bahan di resep yang sama` };
    }
    lines.push({
      productId,
      productKode: row.productKode != null ? String(row.productKode) : undefined,
      productNama: row.productNama != null ? String(row.productNama) : undefined,
      qty,
      satuan: row.satuan != null ? String(row.satuan) : undefined,
      uomId: row.uomId != null ? String(row.uomId) : undefined,
      notes: row.notes != null ? String(row.notes).trim() || undefined : undefined,
    });
  }
  const merged = consolidateRecipeLines(lines);
  if (!merged.length) return { error: 'Resep wajib punya minimal 1 baris bahan' };
  for (const line of merged) {
    if (!(line.qty > 0)) return { error: `Qty bahan ${line.productNama || line.productId} harus > 0` };
  }
  return merged;
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
