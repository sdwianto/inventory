/** Production Plan aggregate root — ADR-001 Sprint 3. */

import type { FpDocStatus, DocHistoryEntry } from '@/lib/food-production/document';
import type { MenuDoc } from '@/lib/food-production/menu';

export const PRODUCTION_PLANS_COLLECTION = 'production_plans';

export type ProductionPlanStatus = FpDocStatus;

/** Penerima porsi MBG / SPPG. */
export const KATEGORI_PORSI_OPTIONS = [
  { value: 'PORSI_BESAR', label: 'Porsi besar', hint: 'SD 4–6 + SMP + SMA + Pendidik + Tendik + Bumil + Busui' },
  { value: 'PORSI_KECIL', label: 'Porsi kecil', hint: 'Balita + TK/PAUD + SD kelas 1–3' },
  { value: 'POSYANDU_BUMIL_BUSUI', label: 'Posyandu Bumil Busui', hint: 'Totebag' },
  { value: 'POSYANDU_BALITA', label: 'Posyandu Balita', hint: 'Totebag' },
] as const;

export type KategoriPorsi = (typeof KATEGORI_PORSI_OPTIONS)[number]['value'];

const KATEGORI_PORSI_SET = new Set<string>(KATEGORI_PORSI_OPTIONS.map((o) => o.value));

export function isKategoriPorsi(v: unknown): v is KategoriPorsi {
  return typeof v === 'string' && KATEGORI_PORSI_SET.has(v);
}

export function kategoriPorsiLabel(v: string | undefined | null): string {
  if (!v) return '—';
  const opt = KATEGORI_PORSI_OPTIONS.find((o) => o.value === v);
  if (!opt) return v;
  // Semua opsi punya hint (as const) — jangan pakai ternary falsy-branch (jadi `never` di tsc).
  return `${opt.label} (${opt.hint})`;
}

/** Normalize one or many kategori porsi (checkbox multi-select). Preserves option order. */
export function normalizeKategoriPorsiList(raw: unknown): KategoriPorsi[] | { error: string } {
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) list = [raw];
  else return { error: 'Minimal satu kategori porsi wajib dipilih' };

  const seen = new Set<KategoriPorsi>();
  for (const item of list) {
    const v = String(item || '').trim();
    if (!v) continue;
    if (!isKategoriPorsi(v)) return { error: `Kategori porsi tidak valid: ${v}` };
    seen.add(v);
  }
  if (!seen.size) return { error: 'Minimal satu kategori porsi wajib dipilih' };
  return KATEGORI_PORSI_OPTIONS.map((o) => o.value).filter((v) => seen.has(v));
}

export function kategoriPorsiListLabel(list: KategoriPorsi[] | undefined | null): string {
  if (!list?.length) return '—';
  return list
    .map((v) => KATEGORI_PORSI_OPTIONS.find((o) => o.value === v)?.label || v)
    .join(', ');
}

/**
 * Baris rencana: pilih resep langsung (baru), atau menu (legacy).
 * Exactly one of recipeId | menuId per line after normalize.
 */
export interface ProductionPlanLine {
  /** @deprecated legacy — plan → menu.items → resep. Prefer recipeId. */
  menuId?: string;
  menuKode?: string;
  menuNama?: string;
  /** Menu version snapshotted when plan line was saved. */
  menuVersion?: number;
  /** Resep yang dimasak (path utama). */
  recipeId?: string;
  recipeKode?: string;
  recipeNama?: string;
  /** Kategori penerima porsi untuk baris ini (multi-select). */
  kategoriPorsiList?: KategoriPorsi[];
  /** Target portions for this recipe/menu on the plan date. */
  targetPorsi: number;
  notes?: string;
}

/**
 * Override qty / status bahan pada RPN (tidak mengubah resep master).
 * Dipakai MRP / Rencana Kebutuhan / PO dari rencana ini.
 */
export interface PlanMaterialOverride {
  recipeId: string;
  productId: string;
  /** Qty kebutuhan manual (gross). Diabaikan jika excluded. */
  qty: number;
  /** true = dicoret — tidak masuk MRP/PO. */
  excluded?: boolean;
  productKode?: string;
  productNama?: string;
  satuan?: string;
}

export interface ProductionPlanDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  /** Production / serving date (YYYY-MM-DD). */
  tanggal: string;
  kitchenId: string;
  kitchenNama?: string;
  /** Denorm from kitchen.defaultWarehouseKode — for MRP / Issue later. */
  kitchenWarehouseKode?: string;
  /** @deprecated gunakan kategoriPorsiList — disimpan sebagai kategori pertama untuk kompatibilitas. */
  kategoriPorsi?: KategoriPorsi;
  /** Kategori penerima porsi (MBG) — multi-select. */
  kategoriPorsiList?: KategoriPorsi[];
  lines: ProductionPlanLine[];
  /**
   * Qty kebutuhan manual per resep+produk (gross).
   * Hanya diedit saat Draft/Diajukan — resep master tidak berubah.
   */
  materialOverrides?: PlanMaterialOverride[];
  /**
   * Buffer kebutuhan per resep (recipeId → persen).
   * Contoh: { [recipeId]: 3 } menambah 3% ke qty hitungan resep (bukan override manual).
   */
  recipeBufferPct?: Record<string, number>;
  status: ProductionPlanStatus;
  history: DocHistoryEntry[];
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export function materialOverrideKey(recipeId: string, productId: string): string {
  return `${String(recipeId || '').trim()}::${String(productId || '').trim()}`;
}

/** Buffer standar kebutuhan bahan (UI: Buffer 3%). */
export const RECIPE_NEED_BUFFER_PCT = 3;

export function getRecipeBufferPct(
  map: Record<string, number> | null | undefined,
  recipeId: string | null | undefined,
): number {
  const id = String(recipeId || '').trim();
  if (!id || !map) return 0;
  const n = Number(map[id]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, Math.round(n));
}

/** Terapkan buffer persen ke qty hitungan (override manual tidak lewat sini). */
export function applyRecipeBufferQty(qty: number, bufferPct: number): number {
  const q = Number(qty) || 0;
  const pct = Number(bufferPct) || 0;
  if (!(q > 0) || !(pct > 0)) return q;
  return q * (1 + pct / 100);
}

export function normalizeRecipeBufferPct(
  raw: unknown,
): Record<string, number> | { error: string } {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'recipeBufferPct harus object' };
  }
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const recipeId = String(key || '').trim();
    if (!recipeId) continue;
    if (val == null || val === '' || val === false || val === 0) continue;
    const n = val === true ? RECIPE_NEED_BUFFER_PCT : Number(val);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { error: `Buffer resep ${recipeId} tidak valid` };
    }
    const pct = Math.round(n);
    if (pct > 0) out[recipeId] = pct;
  }
  return out;
}

export function normalizeMaterialOverrides(
  raw: unknown,
): PlanMaterialOverride[] | { error: string } {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: 'materialOverrides harus array' };
  const out: PlanMaterialOverride[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const recipeId = String(row?.recipeId || '').trim();
    const productId = String(row?.productId || '').trim();
    const excluded = row?.excluded === true;
    const qtyRaw = row?.qty;
    const qty = qtyRaw == null || qtyRaw === '' ? 0 : Number(qtyRaw);
    if (!recipeId) return { error: `Override baris ${i + 1}: recipeId wajib` };
    if (!productId) return { error: `Override baris ${i + 1}: productId wajib` };
    if (!Number.isFinite(qty) || qty < 0) {
      return { error: `Override baris ${i + 1}: qty tidak valid` };
    }
    const key = materialOverrideKey(recipeId, productId);
    if (seen.has(key)) continue;
    seen.add(key);
    // Skip no-op rows (not excluded and qty unused) — keep if excluded or qty set
    out.push({
      recipeId,
      productId,
      qty: Math.round((qty + Number.EPSILON) * 1e6) / 1e6,
      excluded: excluded || undefined,
      productKode: row.productKode != null ? String(row.productKode) : undefined,
      productNama: row.productNama != null ? String(row.productNama) : undefined,
      satuan: row.satuan != null ? String(row.satuan) : undefined,
    });
  }
  return out;
}

/** Qty override map — item yang dicoret tidak ikut. */
export function materialOverridesMap(
  overrides: PlanMaterialOverride[] | undefined | null,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const o of overrides || []) {
    if (o.excluded) continue;
    const key = materialOverrideKey(o.recipeId, o.productId);
    if (!key.startsWith('::') && !key.endsWith('::')) {
      map.set(key, Number(o.qty) || 0);
    }
  }
  return map;
}

/** Set key resep::produk yang dicoret (tidak masuk MRP/PO). */
export function materialExcludedSet(
  overrides: PlanMaterialOverride[] | undefined | null,
): Set<string> {
  const set = new Set<string>();
  for (const o of overrides || []) {
    if (!o.excluded) continue;
    const key = materialOverrideKey(o.recipeId, o.productId);
    if (!key.startsWith('::') && !key.endsWith('::')) set.add(key);
  }
  return set;
}

/**
 * Upsert satu override qty / coret.
 * - clear: true → hapus override sepenuhnya
 * - excluded / qty dapat di-set terpisah
 */
export function upsertMaterialOverride(
  existing: PlanMaterialOverride[] | undefined | null,
  next: {
    recipeId: string;
    productId: string;
    qty?: number | null;
    excluded?: boolean;
    clear?: boolean;
    /** Qty cadangan saat membuat override baru tanpa qty (mis. hanya coret). */
    fallbackQty?: number;
    productKode?: string;
    productNama?: string;
    satuan?: string;
  },
): PlanMaterialOverride[] | { error: string } {
  const recipeId = String(next.recipeId || '').trim();
  const productId = String(next.productId || '').trim();
  if (!recipeId || !productId) return { error: 'recipeId dan productId wajib' };
  const key = materialOverrideKey(recipeId, productId);
  const prev = (existing || []).find(
    (o) => materialOverrideKey(o.recipeId, o.productId) === key,
  );
  const list = (existing || []).filter(
    (o) => materialOverrideKey(o.recipeId, o.productId) !== key,
  );

  if (next.clear) return list;

  let qty: number;
  if (next.qty != null) {
    if (!Number.isFinite(Number(next.qty))) return { error: 'qty tidak valid' };
    qty = Number(next.qty);
    if (qty < 0) return { error: 'qty tidak boleh negatif' };
  } else if (prev) {
    qty = Number(prev.qty) || 0;
  } else {
    qty = Number(next.fallbackQty) || 0;
  }
  qty = Math.round((qty + Number.EPSILON) * 1e6) / 1e6;

  const excluded = next.excluded !== undefined
    ? next.excluded === true
    : (prev?.excluded === true);

  const fallback = Number(next.fallbackQty);
  const matchesRecipe = Number.isFinite(fallback) && Math.abs(qty - fallback) < 1e-9;
  // Kembali ke hitungan resep murni (tidak coret, qty = resep)
  if (!excluded && matchesRecipe) return list;

  list.push({
    recipeId,
    productId,
    qty,
    excluded: excluded || undefined,
    productKode: next.productKode ?? prev?.productKode,
    productNama: next.productNama ?? prev?.productNama,
    satuan: next.satuan ?? prev?.satuan,
  });
  return list;
}

/** Accepts YYYY-MM-DD only. */
export function isIsoDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === value;
}

export function planLineDedupeKey(line: Pick<ProductionPlanLine, 'menuId' | 'recipeId'>): string {
  const recipeId = String(line.recipeId || '').trim();
  if (recipeId) return `recipe:${recipeId}`;
  const menuId = String(line.menuId || '').trim();
  if (menuId) return `menu:${menuId}`;
  return '';
}

export function planLineDisplayName(line: ProductionPlanLine): string {
  return line.recipeNama
    || line.recipeKode
    || line.menuNama
    || line.menuKode
    || line.recipeId
    || line.menuId
    || '—';
}

export function summarizePlanLines(lines: ProductionPlanLine[] | undefined, max = 2): string {
  const list = lines || [];
  if (!list.length) return '—';
  const parts = list.slice(0, max).map((l) => `${planLineDisplayName(l)} (${l.targetPorsi})`);
  if (list.length > max) parts.push(`+${list.length - max} lain`);
  return parts.join(', ');
}

export function normalizePlanLines(raw: unknown): ProductionPlanLine[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Rencana wajib punya minimal 1 baris resep' };
  }
  const lines: ProductionPlanLine[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const recipeId = String(row?.recipeId || '').trim();
    const menuId = String(row?.menuId || '').trim();
    const targetPorsi = Number(row?.targetPorsi);
    if (recipeId && menuId) {
      return { error: `Baris ${i + 1}: pilih resep atau menu, bukan keduanya` };
    }
    if (!recipeId && !menuId) {
      return { error: `Baris ${i + 1}: resep wajib` };
    }
    if (!Number.isFinite(targetPorsi) || targetPorsi <= 0) {
      return { error: `Baris ${i + 1}: target porsi harus > 0` };
    }
    const key = planLineDedupeKey({ recipeId, menuId });
    if (seen.has(key)) {
      return {
        error: recipeId
          ? `Resep duplikat pada baris ${i + 1}`
          : `Menu duplikat pada baris ${i + 1}`,
      };
    }
    seen.add(key);
    let kategoriPorsiList: KategoriPorsi[] | undefined;
    if (row.kategoriPorsiList !== undefined || row.kategoriPorsi !== undefined) {
      const kp = normalizeKategoriPorsiList(row.kategoriPorsiList ?? row.kategoriPorsi);
      if ('error' in kp) return { error: `Baris ${i + 1}: ${kp.error}` };
      kategoriPorsiList = kp;
    }
    lines.push({
      ...(recipeId
        ? {
          recipeId,
          recipeKode: row.recipeKode != null ? String(row.recipeKode) : undefined,
          recipeNama: row.recipeNama != null ? String(row.recipeNama) : undefined,
        }
        : {
          menuId,
          menuKode: row.menuKode != null ? String(row.menuKode) : undefined,
          menuNama: row.menuNama != null ? String(row.menuNama) : undefined,
        }),
      kategoriPorsiList,
      targetPorsi,
      notes: row.notes != null ? String(row.notes).trim() || undefined : undefined,
    });
  }
  return lines;
}

export function isPlanEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED';
}

export function totalTargetPorsi(lines: ProductionPlanLine[] | undefined): number {
  return (lines || []).reduce((s, l) => s + (Number(l.targetPorsi) || 0), 0);
}

/** Collect menu/recipe ids referenced by plan lines (dual-mode). */
export function collectPlanLineRefs(lines: ProductionPlanLine[] | undefined): {
  menuIds: string[];
  recipeIds: string[];
} {
  const menuIds = [...new Set(
    (lines || []).map((l) => String(l.menuId || '').trim()).filter(Boolean),
  )];
  const recipeIds = [...new Set(
    (lines || []).map((l) => String(l.recipeId || '').trim()).filter(Boolean),
  )];
  return { menuIds, recipeIds };
}

/** Slot resep hasil resolve baris rencana (menu legacy atau resep langsung). */
export type PlanRecipeSlot = {
  menuId?: string;
  menuKode?: string;
  menuNama?: string;
  recipeId: string;
  /** Faktor porsi resep per target porsi baris (1 untuk resep langsung). */
  recipeFactor: number;
};

export function resolvePlanLineRecipeSlots(
  planLine: Pick<ProductionPlanLine, 'menuId' | 'recipeId' | 'menuKode' | 'menuNama'>,
  menusById: Map<string, Pick<MenuDoc, 'id' | 'kode' | 'nama'> & {
    items?: MenuDoc['items'];
    aktif?: boolean;
  }>,
): { ok: true; slots: PlanRecipeSlot[] } | { ok: false; error: string } {
  const recipeId = String(planLine.recipeId || '').trim();
  if (recipeId) {
    return {
      ok: true,
      slots: [{
        recipeId,
        recipeFactor: 1,
        menuId: planLine.menuId,
        menuKode: planLine.menuKode,
        menuNama: planLine.menuNama,
      }],
    };
  }
  const menuId = String(planLine.menuId || '').trim();
  if (!menuId) return { ok: false, error: 'Baris rencana tanpa resep/menu' };
  const menu = menusById.get(menuId);
  if (!menu) return { ok: false, error: `Menu ${menuId} tidak ditemukan` };
  if (menu.aktif === false) {
    return { ok: false, error: `Menu ${menu.kode || menuId} nonaktif` };
  }
  if (!menu.items?.length) {
    return { ok: false, error: `Menu ${menu.kode || menuId} belum punya resep` };
  }
  return {
    ok: true,
    slots: menu.items.map((item) => ({
      menuId: menu.id,
      menuKode: menu.kode || planLine.menuKode,
      menuNama: menu.nama || planLine.menuNama,
      recipeId: item.recipeId,
      recipeFactor: Number(item.porsi) || 1,
    })),
  };
}

export const PLAN_STATUS_LABELS: Record<ProductionPlanStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Diajukan',
  APPROVED: 'Disetujui',
  PROCESSING: 'Diproses',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};
