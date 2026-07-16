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

export interface RecipeDoc {
  id: string;
  tenantId: string;
  kode: string;
  nama: string;
  /** Finished good / output product (itemRole FINISHED_GOOD recommended). */
  finishedGoodProductId: string;
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
  aktif: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizeRecipeLines(
  raw: unknown,
  options?: { finishedGoodProductId?: string },
): RecipeLine[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Resep wajib punya minimal 1 baris bahan' };
  }
  const lines: RecipeLine[] = [];
  const seen = new Set<string>();
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
    if (seen.has(productId)) {
      return { error: `Bahan duplikat pada baris ${i + 1}` };
    }
    seen.add(productId);
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
  return lines;
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
