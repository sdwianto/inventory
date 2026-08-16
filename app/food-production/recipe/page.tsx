'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { isIngredientRole } from '@/lib/food-production/item-role';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';
import ProductSearchSelect from '@/components/ProductSearchSelect';
import { BookOpen, Download, FileUp, Plus, Pencil, RefreshCw, Trash2, ListChecks } from 'lucide-react';
import { str } from '@/types/json';
import {
  DEFAULT_PCT_KECIL,
  computeQtyKecil,
  clampPctKecil,
  isFullPortionProduct,
  portionExceptionMatchSet,
} from '@/lib/food-production/recipe';
import {
  getTkpiFood,
  suggestTkpiMatches,
  tkpiPickerQuery,
} from '@/lib/food-production/tkpi-catalog';
import {
  getUsdaFood,
  suggestUsdaMatches,
} from '@/lib/food-production/usda-catalog';
import {
  defaultKitchenSatuan,
  kitchenSatuanOptionsForBase,
  toBaseRecipeQty,
  type RecipeConversionProduct,
} from '@/lib/food-production/recipe-uom';
import { formatNumber } from '@/lib/format';

function toProductOpt(p: Record<string, unknown>): ProductOpt {
  const nutrition = p.nutrition && typeof p.nutrition === 'object'
    ? (p.nutrition as Record<string, unknown>)
    : undefined;
  const tkpiCode = String(p.tkpiCode || nutrition?.tkpiCode || '').trim() || undefined;
  const usdaCode = String(p.usdaCode || nutrition?.usdaCode || '').trim() || undefined;
  const fromFacts = String(nutrition?.tkpiNama || '').trim() || undefined;
  const tkpiNama = fromFacts || (tkpiCode ? (getTkpiFood(tkpiCode)?.nama || undefined) : undefined);
  const usdaNama = String(nutrition?.usdaNama || '').trim()
    || (usdaCode ? (getUsdaFood(usdaCode)?.namaId || getUsdaFood(usdaCode)?.nama || undefined) : undefined);
  return {
    id: String(p.id || ''),
    kode: String(p.kode || ''),
    nama: String(p.nama || ''),
    satuan: p.satuan ? String(p.satuan) : '',
    recipeBaseGrams: p.recipeBaseGrams != null ? Number(p.recipeBaseGrams) : undefined,
    recipeBaseMl: p.recipeBaseMl != null ? Number(p.recipeBaseMl) : undefined,
    gramsPerUnit: nutrition?.gramsPerUnit != null ? Number(nutrition.gramsPerUnit) : undefined,
    itemRole: p.itemRole ? String(p.itemRole) : undefined,
    aktif: p.aktif !== false,
    tkpiCode,
    tkpiNama,
    usdaCode,
    usdaNama,
  };
}

function HighlightNeedle({ text, needle }: { text: string; needle: string }) {
  const n = needle.trim();
  if (!n) return <>{text}</>;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'ig'));
  return (
    <>
      {parts.map((part, i) => (
        part.toLowerCase() === n.toLowerCase()
          ? <span key={i} className="text-red-600">{part}</span>
          : <span key={i} className="text-blue-800">{part}</span>
      ))}
    </>
  );
}

interface ProductOpt {
  id: string;
  kode: string;
  nama: string;
  satuan?: string;
  recipeBaseGrams?: number;
  recipeBaseMl?: number;
  gramsPerUnit?: number;
  itemRole?: string;
  aktif?: boolean;
  tkpiCode?: string;
  tkpiNama?: string;
  usdaCode?: string;
  usdaNama?: string;
}

interface RecipeLineForm {
  productId: string;
  qtyBesar: string;
  pctKecil: string;
  satuan: string;
  notes: string;
}

interface RecipeRow {
  id: string;
  kode: string;
  nama: string;
  finishedGoodProductId?: string;
  effectiveDate: string;
  yieldQty: number;
  wastePct?: number;
  catatan?: string;
  gambarUrl?: string;
  lines: Array<{
    productId: string;
    qty: number;
    qtyBesar?: number;
    pctKecil?: number;
    qtyKecil?: number;
    satuan?: string;
    qtyBaseBesar?: number;
    qtyBaseKecil?: number;
    factorToBase?: number;
    baseSatuan?: string;
    notes?: string;
    productNama?: string;
  }>;
  aktif: boolean;
}

function productConvFromOpt(p: ProductOpt | undefined): RecipeConversionProduct {
  if (!p) return {};
  return {
    satuan: p.satuan,
    kode: p.kode,
    nama: p.nama,
    recipeBaseGrams: p.recipeBaseGrams,
    recipeBaseMl: p.recipeBaseMl,
    nutrition: p.gramsPerUnit != null ? { gramsPerUnit: p.gramsPerUnit } : undefined,
  };
}

function kitchenOptsForProduct(p: ProductOpt | undefined): string[] {
  if (!p?.satuan) return [];
  return kitchenSatuanOptionsForBase(p.satuan, {
    recipeBaseGrams: p.recipeBaseGrams,
    recipeBaseMl: p.recipeBaseMl,
    gramsPerUnit: p.gramsPerUnit,
    nama: p.nama,
    kode: p.kode,
  });
}

function defaultSatuanForProduct(p: ProductOpt | undefined): string {
  if (!p?.satuan) return '';
  return defaultKitchenSatuan(p.satuan, {
    recipeBaseGrams: p.recipeBaseGrams,
    recipeBaseMl: p.recipeBaseMl,
    gramsPerUnit: p.gramsPerUnit,
    nama: p.nama,
    kode: p.kode,
  });
}

/** Live preview: kitchen qty → product base. */
function basePreview(
  qtyKitchen: number,
  kitchenSatuan: string,
  product: ProductOpt | undefined,
): { text: string; ok: boolean } {
  if (!product?.satuan || !kitchenSatuan || !(qtyKitchen > 0)) {
    return { text: '', ok: true };
  }
  const r = toBaseRecipeQty(qtyKitchen, kitchenSatuan, productConvFromOpt(product));
  if ('error' in r) return { text: r.error, ok: false };
  return {
    text: `= ${formatNumber(r.qtyBase)} ${r.baseSatuan}`,
    ok: true,
  };
}

const emptyLine = (): RecipeLineForm => ({
  productId: '',
  qtyBesar: '1',
  pctKecil: String(DEFAULT_PCT_KECIL),
  satuan: '',
  notes: '',
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeNama(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function lineFromDoc(l: RecipeRow['lines'][number]): RecipeLineForm {
  const qtyBesar = Number(l.qtyBesar ?? l.qty) || 0;
  const pctKecil = l.pctKecil != null ? clampPctKecil(l.pctKecil) : DEFAULT_PCT_KECIL;
  return {
    productId: l.productId,
    qtyBesar: String(qtyBesar),
    pctKecil: String(pctKecil),
    satuan: l.satuan || '',
    notes: l.notes || '',
  };
}

/** Same productId → one row; qtyBesar summed. Keeps at most one empty row at end. */
function consolidateFormLines(rows: RecipeLineForm[]): RecipeLineForm[] {
  const byId = new Map<string, RecipeLineForm>();
  let hasEmpty = false;
  for (const line of rows) {
    const id = String(line.productId || '').trim();
    if (!id) {
      hasEmpty = true;
      continue;
    }
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...line, productId: id });
      continue;
    }
    const q1 = Number(existing.qtyBesar) || 0;
    const q2 = Number(line.qtyBesar) || 0;
    existing.qtyBesar = String(q1 + q2);
    if (!existing.satuan && line.satuan) existing.satuan = line.satuan;
    if (line.notes?.trim()) {
      const a = existing.notes.trim();
      const b = line.notes.trim();
      if (a !== b) existing.notes = a ? `${a}; ${b}` : b;
    }
  }
  const merged = [...byId.values()];
  if (hasEmpty || merged.length === 0) merged.push(emptyLine());
  return merged;
}

export default function FoodProductionRecipePage() {
  const [rows, setRows] = useState<RecipeRow[]>([]);
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RecipeRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [nextKode, setNextKode] = useState('RSP-0001');
  const [namaSuggestOpen, setNamaSuggestOpen] = useState(false);
  const [loadedFrom, setLoadedFrom] = useState<{ kode: string; nama: string } | null>(null);
  const namaWrapRef = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState({
    kode: '',
    nama: '',
    effectiveDate: today(),
    yieldQty: '500',
    wastePct: '',
    catatan: '',
    aktif: true,
  });
  const [lines, setLines] = useState<RecipeLineForm[]>([emptyLine()]);
  const [gambarPhotos, setGambarPhotos] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [exceptionOpen, setExceptionOpen] = useState(false);
  const [exceptions, setExceptions] = useState<Array<{
    id: string;
    productId: string;
    productKode?: string;
    productNama?: string;
  }>>([]);
  const [exceptionSaving, setExceptionSaving] = useState(false);
  const [exceptionPickerKey, setExceptionPickerKey] = useState(0);
  const [tkpiPick, setTkpiPick] = useState<{ productId: string; nama: string } | null>(null);
  const [tkpiHits, setTkpiHits] = useState<Array<{
    kode: string;
    nama: string;
    namaId?: string;
    energiKcal: number;
    proteinG?: number;
    bddPct?: number;
    kelompok?: string;
  }>>([]);
  const [usdaHits, setUsdaHits] = useState<Array<{
    kode: string;
    nama: string;
    namaId?: string;
    energiKcal: number;
    proteinG?: number;
    bddPct?: number;
    kelompok?: string;
  }>>([]);
  const [tkpiQ, setTkpiQ] = useState('');
  const [tkpiBusy, setTkpiBusy] = useState(false);
  const [tkpiSaving, setTkpiSaving] = useState(false);
  const applyingTkpi = useRef(new Set<string>());
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<{
    summary?: { recipes: number; ready: number; blocked: number; productsAvailable?: number };
    parseErrors?: string[];
    recipes?: Array<{
      nama: string;
      ok: boolean;
      yieldQty: number;
      errors: string[];
      lines: Array<{
        bahanKode: string;
        bahanNama: string;
        qty: number;
        match: string;
        productKode?: string;
        productNama?: string;
      }>;
    }>;
    source: 'excel' | 'seed';
    excelBase64?: string;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rRes, pRes, kRes, eRes] = await Promise.all([
        fetch('/api/recipes', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/products?limit=200&enrichUom=0', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/recipes?nextKode=1', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/recipe-portion-exceptions', { headers: { ...actingTenantHeaders() } }),
      ]);
      const rData = await rRes.json();
      const pData = await pRes.json();
      const kData = await kRes.json();
      const eData = await eRes.json();
      if (!rRes.ok) throw new Error(rData?.error || 'Gagal memuat resep');
      setRows(Array.isArray(rData) ? rData : []);
      if (kRes.ok && kData?.kode) setNextKode(String(kData.kode));
      if (eRes.ok && Array.isArray(eData)) {
        setExceptions(eData.map((row: Record<string, unknown>) => ({
          id: String(row.id),
          productId: String(row.productId),
          productKode: row.productKode != null ? String(row.productKode) : undefined,
          productNama: row.productNama != null ? String(row.productNama) : undefined,
        })));
      }
      const list = Array.isArray(pData)
        ? pData
        : (Array.isArray(pData?.items) ? pData.items : (Array.isArray(pData?.data) ? pData.data : []));
      setProducts(list.map((p: Record<string, unknown>) => toProductOpt(p)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat resep');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    for (const line of lines) {
      if (!line.productId) continue;
      const product = products.find((p) => p.id === line.productId);
      if (product) void applyUniqueTkpiIfNeeded(product);
    }
  }, [open, lines, products]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!namaWrapRef.current?.contains(e.target as Node)) {
        setNamaSuggestOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  /**
   * Bahan resep = produk aktif dengan peran bahan (INGREDIENT/PACKAGING/…).
   * Termasuk master yang disinkron dari sales.app — di SPPG itu sumber utama bahan dapur.
   */
  const filterIngredientProduct = useCallback(
    (p: { itemRole?: unknown; aktif?: unknown }) => {
      if (p.aktif === false) return false;
      return isIngredientRole(p.itemRole);
    },
    [],
  );

  const exceptionKeys = useMemo(
    () => portionExceptionMatchSet(exceptions),
    [exceptions],
  );

  function productIsFullPortion(productId: string, kode?: string): boolean {
    return isFullPortionProduct({ productId, productKode: kode }, exceptionKeys);
  }

  async function addPortionException(productId: string) {
    if (!productId || exceptionSaving) return;
    if (exceptions.some((e) => e.productId === productId)) {
      toast.message('Produk sudah di daftar pengecualian');
      return;
    }
    setExceptionSaving(true);
    try {
      const res = await fetch('/api/recipe-portion-exceptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ productId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menambah pengecualian');
      toast.success('Item tetap 100% untuk porsi kecil');
      setExceptionPickerKey((k) => k + 1);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menambah pengecualian');
    } finally {
      setExceptionSaving(false);
    }
  }

  async function removePortionException(id: string) {
    if (exceptionSaving) return;
    setExceptionSaving(true);
    try {
      const res = await fetch(`/api/recipe-portion-exceptions/${id}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menghapus');
      toast.success('Pengecualian dihapus');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menghapus');
    } finally {
      setExceptionSaving(false);
    }
  }

  async function persistProductTkpi(productId: string, tkpiCode: string) {
    const res = await fetch(`/api/nutrition-profiles/${productId}/apply-tkpi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
      body: JSON.stringify({ tkpiCode }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error(String(data?.error || 'Gagal simpan TKPI'));
    const nutrition = data.nutrition && typeof data.nutrition === 'object'
      ? (data.nutrition as Record<string, unknown>)
      : undefined;
    const food = getTkpiFood(tkpiCode);
    setProducts((prev) => prev.map((p) => (
      p.id === productId
        ? {
          ...p,
          tkpiCode,
          tkpiNama: String(nutrition?.tkpiNama || food?.nama || p.tkpiNama || tkpiCode),
          usdaCode: undefined,
          usdaNama: undefined,
          gramsPerUnit: nutrition?.gramsPerUnit != null ? Number(nutrition.gramsPerUnit) : p.gramsPerUnit,
        }
        : p
    )));
  }

  async function persistProductUsda(productId: string, usdaCode: string) {
    const res = await fetch(`/api/nutrition-profiles/${productId}/apply-usda`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
      body: JSON.stringify({ usdaCode }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error(String(data?.error || 'Gagal simpan USDA'));
    const nutrition = data.nutrition && typeof data.nutrition === 'object'
      ? (data.nutrition as Record<string, unknown>)
      : undefined;
    const food = getUsdaFood(usdaCode);
    setProducts((prev) => prev.map((p) => (
      p.id === productId
        ? {
          ...p,
          usdaCode,
          usdaNama: String(nutrition?.usdaNama || food?.namaId || food?.nama || p.usdaNama || usdaCode),
          tkpiCode: undefined,
          tkpiNama: undefined,
          gramsPerUnit: nutrition?.gramsPerUnit != null ? Number(nutrition.gramsPerUnit) : p.gramsPerUnit,
        }
        : p
    )));
  }

  async function applyUniqueTkpiIfNeeded(product: ProductOpt) {
    if (!product.id || product.tkpiCode || product.usdaCode || applyingTkpi.current.has(product.id)) return;
    const tkpi = suggestTkpiMatches(product.nama, 3);
    if (tkpi.length === 1) {
      applyingTkpi.current.add(product.id);
      try {
        await persistProductTkpi(product.id, tkpi[0].kode);
      } catch {
        /* tampilkan pilih jika gagal simpan */
      } finally {
        applyingTkpi.current.delete(product.id);
      }
      return;
    }
    if (tkpi.length > 0) return;
    const usda = suggestUsdaMatches(product.nama, 3);
    if (usda.length !== 1 || usda[0].via !== 'alias') return;
    applyingTkpi.current.add(product.id);
    try {
      await persistProductUsda(product.id, usda[0].kode);
    } catch {
      /* tampilkan pilih jika gagal simpan */
    } finally {
      applyingTkpi.current.delete(product.id);
    }
  }

  function mapCatalogHits(rows: Array<Record<string, unknown>> | undefined) {
    return (Array.isArray(rows) ? rows : []).map((h) => ({
      kode: String(h.kode || ''),
      nama: String(h.nama || ''),
      namaId: h.namaId != null ? String(h.namaId) : undefined,
      energiKcal: Number(h.energiKcal) || 0,
      proteinG: h.proteinG != null ? Number(h.proteinG) : undefined,
      lemakG: h.lemakG != null ? Number(h.lemakG) : undefined,
      karbohidratG: h.karbohidratG != null ? Number(h.karbohidratG) : undefined,
      bddPct: h.bddPct != null ? Number(h.bddPct) : undefined,
      kelompok: h.kelompok != null ? String(h.kelompok) : undefined,
    }));
  }

  async function loadTkpiHits(q: string) {
    const needle = q.trim();
    if (needle.length < 2) {
      setTkpiHits([]);
      setUsdaHits([]);
      return;
    }
    setTkpiBusy(true);
    try {
      const res = await fetch(
        `/api/nutrition-profiles/tkpi?q=${encodeURIComponent(needle)}&limit=80`,
        { headers: { ...actingTenantHeaders() } },
      );
      const data = await res.json() as {
        items?: Array<Record<string, unknown>>;
        usdaItems?: Array<Record<string, unknown>>;
      };
      if (!res.ok) throw new Error('Gagal cari TKPI');
      setTkpiHits(mapCatalogHits(data.items));
      setUsdaHits(mapCatalogHits(data.usdaItems));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal cari TKPI');
      setTkpiHits([]);
      setUsdaHits([]);
    } finally {
      setTkpiBusy(false);
    }
  }

  function openTkpiPicker(product: ProductOpt) {
    const q = tkpiPickerQuery(product.nama) || product.nama;
    setTkpiPick({ productId: product.id, nama: product.nama });
    setTkpiQ(q);
    void loadTkpiHits(q);
  }

  async function chooseTkpi(kode: string) {
    if (!tkpiPick || tkpiSaving) return;
    setTkpiSaving(true);
    try {
      await persistProductTkpi(tkpiPick.productId, kode);
      toast.success('TKPI disimpan ke master produk');
      setTkpiPick(null);
      setTkpiHits([]);
      setUsdaHits([]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal simpan TKPI');
    } finally {
      setTkpiSaving(false);
    }
  }

  async function chooseUsda(kode: string) {
    if (!tkpiPick || tkpiSaving) return;
    setTkpiSaving(true);
    try {
      await persistProductUsda(tkpiPick.productId, kode);
      toast.success('Gizi USDA (cadangan) disimpan ke master produk');
      setTkpiPick(null);
      setTkpiHits([]);
      setUsdaHits([]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal simpan USDA');
    } finally {
      setTkpiSaving(false);
    }
  }

  const namaSuggestions = useMemo(() => {
    if (editing) return [];
    const q = normalizeNama(form.nama).toLowerCase();
    if (q.length < 1) return [];
    return rows
      .filter((r) => r.aktif !== false)
      .filter((r) => {
        const n = normalizeNama(r.nama).toLowerCase();
        const k = String(r.kode || '').toLowerCase();
        return n.includes(q) || k.includes(q);
      })
      .slice(0, 8);
  }, [editing, form.nama, rows]);

  const exactNamaMatch = useMemo(() => {
    const n = normalizeNama(form.nama).toLowerCase();
    if (!n) return null;
    return rows.find((r) => {
      if (editing && r.id === editing.id) return false;
      return r.aktif !== false && normalizeNama(r.nama).toLowerCase() === n;
    }) || null;
  }, [editing, form.nama, rows]);

  async function openCreate() {
    setEditing(null);
    setLoadedFrom(null);
    setNamaSuggestOpen(false);
    setForm({
      kode: nextKode,
      nama: '',
      effectiveDate: today(),
      yieldQty: '500',
      wastePct: '',
      catatan: '',
      aktif: true,
    });
    setLines([emptyLine()]);
    setGambarPhotos([]);
    setOpen(true);
    try {
      const kRes = await fetch('/api/recipes?nextKode=1', { headers: { ...actingTenantHeaders() } });
      const kData = await kRes.json();
      if (kRes.ok && kData?.kode) {
        const kode = String(kData.kode);
        setNextKode(kode);
        setForm((f) => ({ ...f, kode }));
      }
    } catch {
      // keep cached nextKode
    }
  }

  function openEdit(row: RecipeRow) {
    setEditing(row);
    setLoadedFrom(null);
    setNamaSuggestOpen(false);
    setForm({
      kode: row.kode,
      nama: row.nama,
      effectiveDate: row.effectiveDate || today(),
      yieldQty: String(row.yieldQty || 1),
      wastePct: row.wastePct != null ? String(row.wastePct) : '',
      catatan: row.catatan || '',
      aktif: row.aktif !== false,
    });
    setLines(
      (row.lines || []).length
        ? row.lines.map((l) => lineFromDoc(l))
        : [emptyLine()],
    );
    setGambarPhotos(row.gambarUrl ? [row.gambarUrl] : []);
    setOpen(true);
  }

  function applyFromExisting(row: RecipeRow) {
    setForm((f) => ({
      ...f,
      nama: row.nama,
      effectiveDate: row.effectiveDate || today(),
      yieldQty: String(row.yieldQty || 1),
      wastePct: row.wastePct != null ? String(row.wastePct) : '',
      catatan: row.catatan || '',
      aktif: true,
    }));
    setLines(
      (row.lines || []).length
        ? row.lines.map((l) => lineFromDoc(l))
        : [emptyLine()],
    );
    setGambarPhotos(row.gambarUrl ? [row.gambarUrl] : []);
    setLoadedFrom({ kode: row.kode, nama: row.nama });
    setNamaSuggestOpen(false);
    toast.message(`Detail dimuat dari ${row.kode} — ubah nama untuk simpan sebagai resep baru`);
  }

  async function save() {
    setSaving(true);
    try {
      const nama = normalizeNama(form.nama);
      if (!nama) throw new Error('Nama resep wajib diisi');
      if (!editing && exactNamaMatch) {
        throw new Error(
          `Resep "${exactNamaMatch.nama}" sudah ada (${exactNamaMatch.kode}). Ubah nama, atau batalkan jika sama.`,
        );
      }
      const readyLines = consolidateFormLines(lines).filter((l) => l.productId);
      for (const l of readyLines) {
        const product = products.find((p) => p.id === l.productId);
        const preview = basePreview(Number(l.qtyBesar) || 0, l.satuan, product);
        if (!preview.ok) {
          throw new Error(
            `Bahan "${product?.nama || l.productId}": ${preview.text || 'konversi satuan gagal'}`,
          );
        }
        if (!l.satuan) {
          throw new Error(`Bahan "${product?.nama || l.productId}": satuan dapur wajib dipilih`);
        }
      }
      const payload = {
        nama,
        effectiveDate: form.effectiveDate,
        yieldQty: Number(form.yieldQty),
        wastePct: form.wastePct === '' ? null : Number(form.wastePct),
        catatan: form.catatan.trim() || undefined,
        aktif: form.aktif,
        gambarBase64: gambarPhotos[0] || null,
        lines: readyLines.map((l) => ({
          productId: l.productId,
          qtyBesar: Number(l.qtyBesar),
          qty: Number(l.qtyBesar),
          pctKecil: productIsFullPortion(l.productId, products.find((p) => p.id === l.productId)?.kode)
            ? 100
            : clampPctKecil(l.pctKecil),
          satuan: l.satuan || undefined,
          notes: l.notes.trim() || undefined,
        })),
      };
      const url = editing ? `/api/recipes/${editing.id}` : '/api/recipes';
      const method = editing ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan');
      toast.success(editing ? 'Resep diperbarui' : 'Resep ditambahkan');
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  }

  async function downloadTemplate() {
    try {
      const res = await fetch('/api/recipes/import-template', { headers: { ...actingTenantHeaders() } });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || 'Gagal unduh template');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'template-import-resep-sppg.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal unduh');
    }
  }

  async function previewImport(payload: { excelBase64?: string; source?: 'excel' | 'seed' }) {
    setImporting(true);
    try {
      const source = payload.source || 'excel';
      const res = await fetch('/api/recipes/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          dryRun: true,
          source,
          ...(source === 'excel' ? { excelBase64: payload.excelBase64 || '' } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal preview');
      setImportPreview({
        ...data,
        source,
        excelBase64: payload.excelBase64,
      });
      if (data.summary?.ready === 0) {
        toast.message('Belum ada resep siap — samakan nama/kode bahan dengan master Produk');
      } else {
        toast.success(`${data.summary.ready} resep siap import (${data.summary.blocked} perlu diperbaiki)`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal preview');
    } finally {
      setImporting(false);
    }
  }

  async function onPickExcel(file: File | null) {
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
      toast.error('Gunakan file Excel (.xlsx)');
      return;
    }
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const excelBase64 = btoa(binary);
    await previewImport({ excelBase64, source: 'excel' });
  }

  async function commitImport() {
    if (!importPreview?.recipes?.length) {
      toast.error('Preview dulu (Excel atau paket contoh)');
      return;
    }
    if (!(importPreview.summary?.ready)) {
      toast.error('Tidak ada resep siap import');
      return;
    }
    setImporting(true);
    try {
      const res = await fetch('/api/recipes/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(
          importPreview.source === 'seed'
            ? { source: 'seed', dryRun: false }
            : { source: 'excel', excelBase64: importPreview.excelBase64 || '', dryRun: false },
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal import');
      toast.success(
        `Import ${data.summary?.created || 0} resep`
        + (data.summary?.skipped ? ` · ${data.summary.skipped} dilewati` : ''),
      );
      setImportOpen(false);
      setImportPreview(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal import');
    } finally {
      setImporting(false);
    }
  }

  async function removeRecipe(row: RecipeRow) {
    const hard = !row.aktif;
    const okConfirm = window.confirm(
      hard
        ? `Hapus permanen resep ${row.kode} — ${row.nama}?`
        : `Nonaktifkan resep ${row.kode} — ${row.nama}?`,
    );
    if (!okConfirm) return;
    try {
      const qs = hard ? '?hard=1' : '';
      const res = await fetch(`/api/recipes/${row.id}${qs}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menghapus');
      toast.success(hard ? 'Resep dihapus' : 'Resep dinonaktifkan');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menghapus');
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            Resep
          </h1>
          <p className="text-sm text-muted-foreground">
            Master resep (BOM) + bank data via import Excel / paket contoh SPPG
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Muat ulang
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setImportPreview(null);
              setImportOpen(true);
            }}
          >
            <FileUp className="h-4 w-4 mr-1" />
            Import bank
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setExceptionOpen(true)}
          >
            <ListChecks className="h-4 w-4 mr-1" />
            Pengecualian porsi
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" />
            Tambah Resep
          </Button>
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium w-14">Gambar</th>
              <th className="text-left p-3 font-medium">Kode</th>
              <th className="text-left p-3 font-medium">Nama Resep</th>
              <th className="text-left p-3 font-medium">Hasil</th>
              <th className="text-left p-3 font-medium">Efektif</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted-foreground">Memuat…</td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted-foreground">
                  Belum ada resep. Buat resep sebelum Menu / Rencana Produksi.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-2">
                  {row.gambarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={row.gambarUrl}
                      alt={row.nama}
                      className="h-10 w-10 rounded object-cover border bg-muted"
                    />
                  ) : (
                    <div className="h-10 w-10 rounded border bg-muted/40" />
                  )}
                </td>
                <td className="p-3 font-mono text-xs">{row.kode}</td>
                <td className="p-3 font-medium">{row.nama}</td>
                <td className="p-3">{row.yieldQty} porsi</td>
                <td className="p-3 whitespace-nowrap">{row.effectiveDate || '—'}</td>
                <td className="p-3">{row.aktif ? 'Aktif' : 'Nonaktif'}</td>
                <td className="p-3 text-right whitespace-nowrap">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(row)} title="Ubah">
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void removeRecipe(row)}
                    title={row.aktif ? 'Nonaktifkan' : 'Hapus permanen'}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-6xl w-[min(98vw,80rem)] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Ubah Resep' : 'Tambah Resep'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Kode</Label>
              <Input
                value={form.kode}
                readOnly
                disabled
                className="font-mono bg-muted"
              />
              <p className="text-xs text-muted-foreground">
                {editing ? 'Kode tidak dapat diubah' : 'Nomor item otomatis (RSP-0001, …)'}
              </p>
            </div>
            <div className="space-y-1">
              <Label>Hasil (porsi) *</Label>
              <Input
                type="number"
                min={1}
                value={form.yieldQty}
                onChange={(e) => setForm((f) => ({ ...f, yieldQty: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Qty bahan diisi untuk satu batch = Hasil. RPN akan mengalikan (porsi rencana / Hasil).
              </p>
            </div>
            <div className="space-y-1 sm:col-span-2" ref={namaWrapRef}>
              <Label>Nama Resep *</Label>
              <Input
                value={form.nama}
                autoComplete="off"
                placeholder="Ketik nama resep…"
                onChange={(e) => {
                  setForm((f) => ({ ...f, nama: e.target.value }));
                  setNamaSuggestOpen(true);
                  if (loadedFrom) setLoadedFrom(null);
                }}
                onFocus={() => {
                  if (!editing) setNamaSuggestOpen(true);
                }}
              />
              {!editing && namaSuggestOpen && namaSuggestions.length > 0 && (
                <ul className="mt-1 max-h-44 overflow-y-auto rounded-md border bg-white shadow-sm text-sm z-10 relative">
                  {namaSuggestions.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 hover:bg-muted/80"
                        onClick={() => applyFromExisting(r)}
                      >
                        <span className="font-medium">{r.nama}</span>
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{r.kode}</span>
                        <span className="block text-xs text-muted-foreground">
                          {r.yieldQty} porsi · {(r.lines || []).length} bahan — klik untuk muat detail
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                Identitas resep (bukan master Produk). Ketik untuk cari &amp; muat bahan dari resep lama;
                simpan wajib nama berbeda.
              </p>
              {loadedFrom && (
                <p className="text-xs text-amber-700">
                  Detail dimuat dari {loadedFrom.kode} ({loadedFrom.nama}). Ubah nama sebelum simpan
                  sebagai resep baru; jika sama persis, batalkan saja.
                </p>
              )}
              {!editing && exactNamaMatch && (
                <p className="text-xs text-destructive">
                  Nama sudah dipakai {exactNamaMatch.kode}. Ubah nama atau batalkan.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Waste % (opsional)</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={form.wastePct}
                onChange={(e) => setForm((f) => ({ ...f, wastePct: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Tanggal efektif</Label>
              <Input
                type="date"
                value={form.effectiveDate}
                onChange={(e) => setForm((f) => ({ ...f, effectiveDate: e.target.value }))}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Catatan</Label>
              <Input
                value={form.catatan}
                onChange={(e) => setForm((f) => ({ ...f, catatan: e.target.value }))}
                placeholder="Opsional"
              />
            </div>
            <div className="sm:col-span-2">
              <PhotoUploadField
                label="Gambar"
                hint="Opsional. Maks. 1 foto, otomatis dikompres sebelum disimpan."
                photos={gambarPhotos}
                onChange={setGambarPhotos}
                maxPhotos={1}
              />
            </div>
            {editing && (
              <label className="sm:col-span-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.aktif}
                  onChange={(e) => setForm((f) => ({ ...f, aktif: e.target.checked }))}
                />
                Aktif
              </label>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label>Bahan</Label>
                <p className="text-[11px] text-muted-foreground">
                  Porsi Besar Sekolah &amp; Posyandu = 100%; Kecil Sekolah &amp; Posyandu = % dari qty besar.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setLines((prev) => [...prev, emptyLine()])}
              >
                <Plus className="h-3 w-3 mr-1" />
                Baris
              </Button>
            </div>
            <div className="rounded-md border overflow-hidden">
              <div className="hidden sm:grid sm:grid-cols-[minmax(0,1.5fr)_minmax(13.5rem,1.2fr)_5.5rem_4.5rem_5.5rem_minmax(6.5rem,0.85fr)_2.5rem] gap-2 px-2 py-1.5 bg-muted/50 text-xs font-medium text-muted-foreground">
                <div>Produk</div>
                <div className="whitespace-nowrap">TKPI/USDA 100g</div>
                <div>Qty besar</div>
                <div>% kecil</div>
                <div>Qty kecil</div>
                <div>Satuan dapur</div>
                <div />
              </div>
              <div className="divide-y">
                {lines.map((line, idx) => {
                  const product = products.find((p) => p.id === line.productId);
                  const fullPortion = productIsFullPortion(line.productId, product?.kode);
                  const qtyKecilPreview = fullPortion
                    ? (Number(line.qtyBesar) || 0)
                    : computeQtyKecil(
                      Number(line.qtyBesar) || 0,
                      clampPctKecil(line.pctKecil),
                    );
                  const satuanOpts = kitchenOptsForProduct(product);
                  const preview = basePreview(
                    Number(line.qtyBesar) || 0,
                    line.satuan,
                    product,
                  );
                  return (
                  <div
                    key={idx}
                    className="grid gap-2 sm:grid-cols-[minmax(0,1.5fr)_minmax(13.5rem,1.2fr)_5.5rem_4.5rem_5.5rem_minmax(6.5rem,0.85fr)_2.5rem] items-start px-2 py-1.5"
                  >
                    <div className="min-w-0">
                      <span className="sm:hidden text-[11px] text-muted-foreground">Produk</span>
                      <ProductSearchSelect
                        value={line.productId}
                        withWarehouseStock={false}
                        placeholder="Ketik kode / nama bahan…"
                        selectedProduct={
                          line.productId
                            ? (products.find((p) => p.id === line.productId) as unknown as Record<string, unknown> | undefined)
                              || null
                            : null
                        }
                        filterProduct={filterIngredientProduct}
                        onChange={(id) => {
                          // Clear only — selection + consolidate handled in onProductPick.
                          if (id) return;
                          setLines((prev) => prev.map((l, i) => (
                            i === idx ? { ...l, productId: '', satuan: '' } : l
                          )));
                        }}
                        onProductPick={(p) => {
                          const picked = toProductOpt(p);
                          const productId = picked.id;
                          const kitchenSatuan = defaultSatuanForProduct(picked) || str(p.satuan);
                          const pct = productIsFullPortion(productId, picked.kode) ? '100' : undefined;
                          setLines((prev) => {
                            const existingIdx = prev.findIndex(
                              (l, i) => i !== idx && l.productId === productId,
                            );
                            if (existingIdx >= 0) {
                              const addQty = Number(prev[idx]?.qtyBesar) || 0;
                              const next = prev
                                .map((l, i) => {
                                  if (i !== existingIdx) return l;
                                  return {
                                    ...l,
                                    qtyBesar: String((Number(l.qtyBesar) || 0) + addQty),
                                    satuan: l.satuan || kitchenSatuan,
                                    ...(pct ? { pctKecil: pct } : {}),
                                  };
                                })
                                .filter((_, i) => i !== idx);
                              toast.message('Bahan sama digabung — qty besar dijumlahkan');
                              return next.length ? next : [emptyLine()];
                            }
                            return consolidateFormLines(
                              prev.map((l, i) => (
                                i === idx
                                  ? { ...l, productId, satuan: kitchenSatuan, ...(pct ? { pctKecil: pct } : {}) }
                                  : l
                              )),
                            );
                          });
                          setProducts((prev) => {
                            const existing = prev.find((x) => x.id === productId);
                            const merged: ProductOpt = existing
                              ? {
                                ...existing,
                                ...picked,
                                tkpiCode: existing.tkpiCode || picked.tkpiCode,
                                tkpiNama: existing.tkpiNama || picked.tkpiNama,
                                usdaCode: existing.usdaCode || picked.usdaCode,
                                usdaNama: existing.usdaNama || picked.usdaNama,
                              }
                              : picked;
                            void applyUniqueTkpiIfNeeded(merged);
                            if (!existing) return [...prev, merged];
                            return prev.map((x) => (x.id === productId ? merged : x));
                          });
                        }}
                      />
                    </div>
                    <div className="min-w-0">
                      <span className="sm:hidden text-[11px] text-muted-foreground">TKPI/USDA per 100g</span>
                      {(() => {
                        if (!product) {
                          return <span className="text-[11px] text-muted-foreground">—</span>;
                        }
                        const uniqueTkpi = !product.tkpiCode && !product.usdaCode
                          ? suggestTkpiMatches(product.nama, 3)
                          : [];
                        const uniqueUsda = !product.tkpiCode && !product.usdaCode && uniqueTkpi.length === 0
                          ? suggestUsdaMatches(product.nama, 3)
                          : [];
                        const tkpiFood = product.tkpiCode
                          ? getTkpiFood(product.tkpiCode)
                          : (uniqueTkpi.length === 1 ? getTkpiFood(uniqueTkpi[0].kode) : null);
                        const usdaFood = product.usdaCode
                          ? getUsdaFood(product.usdaCode)
                          : (uniqueUsda.length === 1 ? getUsdaFood(uniqueUsda[0].kode) : null);
                        const food = tkpiFood || usdaFood;
                        const isUsda = Boolean(usdaFood && !tkpiFood);
                        const label = product.tkpiNama
                          || product.usdaNama
                          || tkpiFood?.nama
                          || usdaFood?.namaId
                          || usdaFood?.nama
                          || (uniqueTkpi.length === 1 ? uniqueTkpi[0].nama : '')
                          || (uniqueUsda.length === 1 ? (uniqueUsda[0].namaId || uniqueUsda[0].nama) : '')
                          || product.tkpiCode
                          || product.usdaCode
                          || '';
                        if (label) {
                          return (
                            <div className="min-w-0">
                              <button
                                type="button"
                                className="text-left text-[11px] leading-tight text-blue-800 underline-offset-2 hover:underline"
                                title={isUsda
                                  ? `USDA ${product.usdaCode || usdaFood?.kode} — cadangan, bukan TKPI`
                                  : (product.tkpiCode ? `TKPI ${product.tkpiCode} — klik untuk ganti` : 'Klik untuk ganti')}
                                onClick={() => openTkpiPicker(product)}
                              >
                                {label}
                                {isUsda ? ' · USDA' : ''}
                              </button>
                              {food && (
                                <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground tabular-nums whitespace-nowrap">
                                  {formatNumber(food.energiKcal)} kkal · P {formatNumber(food.proteinG)}g · L {formatNumber(food.lemakG)}g · K {formatNumber(food.karbohidratG)}g
                                </p>
                              )}
                            </div>
                          );
                        }
                        return (
                          <button
                            type="button"
                            className="text-xs text-amber-800 underline-offset-2 hover:underline"
                            onClick={() => openTkpiPicker(product)}
                          >
                            pilih
                          </button>
                        );
                      })()}
                    </div>
                    <div>
                      <span className="sm:hidden text-[11px] text-muted-foreground">Qty besar</span>
                      <Input
                        type="number"
                        min={0}
                        step="any"
                        value={line.qtyBesar}
                        aria-label={`Qty besar baris ${idx + 1}`}
                        onChange={(e) => setLines((prev) => prev.map((l, i) => (
                          i === idx ? { ...l, qtyBesar: e.target.value } : l
                        )))}
                      />
                    </div>
                    <div>
                      <span className="sm:hidden text-[11px] text-muted-foreground">% kecil</span>
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        step="any"
                        value={fullPortion ? '100' : line.pctKecil}
                        disabled={fullPortion}
                        aria-label={`Persen kecil baris ${idx + 1}`}
                        title={fullPortion ? 'Pengecualian porsi: tetap 100%' : undefined}
                        onChange={(e) => setLines((prev) => prev.map((l, i) => (
                          i === idx ? { ...l, pctKecil: e.target.value } : l
                        )))}
                      />
                      {fullPortion && (
                        <span className="mt-0.5 block text-[10px] text-amber-800">Tetap 100%</span>
                      )}
                    </div>
                    <div>
                      <span className="sm:hidden text-[11px] text-muted-foreground">Qty kecil</span>
                      <Input
                        type="text"
                        readOnly
                        tabIndex={-1}
                        className="bg-muted/40 text-muted-foreground tabular-nums"
                        value={formatNumber(qtyKecilPreview)}
                        aria-label={`Qty kecil baris ${idx + 1} (otomatis)`}
                        title="Otomatis dari qty besar × %"
                      />
                    </div>
                    <div className="min-w-0">
                      <span className="sm:hidden text-[11px] text-muted-foreground">Satuan dapur</span>
                      <select
                        className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
                        value={line.satuan}
                        disabled={!line.productId || satuanOpts.length === 0}
                        aria-label={`Satuan dapur baris ${idx + 1}`}
                        onChange={(e) => setLines((prev) => prev.map((l, i) => (
                          i === idx ? { ...l, satuan: e.target.value } : l
                        )))}
                      >
                        {!line.satuan && <option value="">Pilih…</option>}
                        {satuanOpts.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                        {line.satuan && !satuanOpts.includes(line.satuan) && (
                          <option value={line.satuan}>{line.satuan}</option>
                        )}
                      </select>
                      {preview.text ? (
                        <p
                          className={`mt-0.5 text-[10px] tabular-nums leading-tight ${
                            preview.ok ? 'text-muted-foreground' : 'text-destructive'
                          }`}
                          title="Konversi ke satuan basis produk (stok / pengadaan)"
                        >
                          {preview.text}
                        </p>
                      ) : product?.satuan ? (
                        <p className="mt-0.5 text-[10px] text-muted-foreground leading-tight">
                          basis {product.satuan}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex justify-end pt-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={lines.length <= 1}
                        aria-label={`Hapus baris ${idx + 1}`}
                        onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button
              onClick={() => void save()}
              disabled={saving || !normalizeNama(form.nama) || (!editing && !!exactNamaMatch)}
            >
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!tkpiPick}
        onOpenChange={(o) => {
          if (!o) {
            setTkpiPick(null);
            setTkpiHits([]);
            setUsdaHits([]);
            setTkpiQ('');
          }
        }}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Pilih gizi — {tkpiPick?.nama}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Utamakan TKPI 2019. Jika tidak ada, pakai cadangan USDA SR Legacy
            (sumber yang sama dengan tabel Andrafarm). Tersimpan ke master produk.
          </p>
          <div className="space-y-2 py-1">
            <Input
              className="h-9"
              placeholder="Cari nama / kode TKPI atau USDA…"
              value={tkpiQ}
              onChange={(e) => {
                const v = e.target.value;
                setTkpiQ(v);
                void loadTkpiHits(v);
              }}
            />
            {tkpiBusy && <p className="text-[11px] text-muted-foreground">Mencari…</p>}
            {!tkpiBusy && tkpiHits.length === 0 && usdaHits.length === 0 && tkpiQ.trim().length >= 2 && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Tidak ada di TKPI 2019 maupun cadangan USDA.
              </p>
            )}
            {tkpiHits.length > 0 && (
              <ul className="max-h-56 overflow-y-auto text-sm divide-y border rounded-md">
                {tkpiHits.map((hit) => (
                  <li key={hit.kode}>
                    <button
                      type="button"
                      disabled={tkpiSaving}
                      className="w-full text-left px-3 py-2 hover:bg-muted/50 disabled:opacity-50"
                      onClick={() => void chooseTkpi(hit.kode)}
                    >
                      <div className="font-mono text-[11px] text-muted-foreground">{hit.kode}</div>
                      <div className="leading-snug">
                        <HighlightNeedle text={hit.nama} needle={tkpiQ} />
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {hit.energiKcal} kkal
                        {hit.proteinG != null ? ` · P ${hit.proteinG}g` : ''}
                        {hit.bddPct != null ? ` · BDD ${hit.bddPct}%` : ''}
                        {hit.kelompok ? ` · ${hit.kelompok}` : ''}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {usdaHits.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-amber-900">
                  Cadangan USDA {tkpiHits.length ? '(jika TKPI tidak cocok)' : '(tidak ada di TKPI 2019)'}
                </p>
                <ul className="max-h-48 overflow-y-auto text-sm divide-y border border-amber-200 rounded-md bg-amber-50/40">
                  {usdaHits.map((hit) => (
                    <li key={hit.kode}>
                      <button
                        type="button"
                        disabled={tkpiSaving}
                        className="w-full text-left px-3 py-2 hover:bg-amber-50 disabled:opacity-50"
                        onClick={() => void chooseUsda(hit.kode)}
                      >
                        <div className="font-mono text-[11px] text-muted-foreground">{hit.kode}</div>
                        <div className="leading-snug">
                          <HighlightNeedle text={hit.namaId || hit.nama} needle={tkpiQ} />
                          {hit.namaId ? (
                            <span className="block text-[11px] text-muted-foreground">{hit.nama}</span>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {hit.energiKcal} kkal
                          {hit.proteinG != null ? ` · P ${hit.proteinG}g` : ''}
                          {hit.bddPct != null ? ` · BDD ${hit.bddPct}%` : ''}
                          {' · USDA SR'}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTkpiPick(null)}>Batal</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={exceptionOpen} onOpenChange={setExceptionOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Pengecualian porsi kecil</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Item di daftar ini tidak dipotong % porsi kecil — qty kecil tetap 100% (sama dengan qty besar).
            Contoh: telur, buah dihitung PCS.
          </p>
          <div className="space-y-2 py-1">
            <Label className="text-xs">Tambah bahan</Label>
            <ProductSearchSelect
              key={exceptionPickerKey}
              value=""
              withWarehouseStock={false}
              placeholder="Cari kode / nama bahan…"
              filterProduct={filterIngredientProduct}
              onChange={() => { /* pilih lewat onProductPick */ }}
              onProductPick={(p) => {
                const id = str(p.id);
                if (id) void addPortionException(id);
              }}
            />
            {exceptions.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Belum ada pengecualian.
              </p>
            )}
            {exceptions.length > 0 && (
            <div className="divide-y rounded-md border">
              {exceptions.map((row) => (
                <div key={row.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-xs">{row.productKode || '—'}</span>
                    <span className="ml-2 text-slate-700">{row.productNama || row.productId}</span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    disabled={exceptionSaving}
                    onClick={() => void removePortionException(row.id)}
                    aria-label={`Hapus ${row.productKode || row.productId}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExceptionOpen(false)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={importOpen}
        onOpenChange={(o) => {
          setImportOpen(o);
          if (!o) setImportPreview(null);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import bank resep SPPG</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm py-1">
            <p className="text-muted-foreground">
              Isi Excel (.xlsx) resep operasional → sistem memetakan bahan ke master Produk (kode/nama).
              Hanya resep yang semua bahannya ketemu yang diimpor.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void downloadTemplate()}>
                <Download className="h-4 w-4 mr-1" /> Unduh template Excel
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={importing}
                onClick={() => fileRef.current?.click()}
              >
                <FileUp className="h-4 w-4 mr-1" /> Pilih file Excel
              </Button>
              <Button
                size="sm"
                disabled={importing}
                onClick={() => void previewImport({ source: 'seed' })}
              >
                Paket contoh SPPG
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                className="hidden"
                onChange={(e) => {
                  void onPickExcel(e.target.files?.[0] || null);
                  e.target.value = '';
                }}
              />
            </div>

            {importPreview && (
              <div className="space-y-2 rounded-md border p-3 bg-muted/20">
                <div className="font-medium">
                  Preview: {importPreview.summary?.ready ?? 0} siap
                  {' · '}
                  {importPreview.summary?.blocked ?? 0} perlu perbaikan
                  {' · '}
                  produk bahan tersedia: {importPreview.summary?.productsAvailable ?? 0}
                </div>
                {(importPreview.parseErrors || []).length > 0 && (
                  <ul className="text-xs text-destructive list-disc pl-4">
                    {importPreview.parseErrors!.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                )}
                <div className="max-h-64 overflow-y-auto space-y-2">
                  {(importPreview.recipes || []).map((r) => (
                    <div
                      key={r.nama}
                      className={`rounded border px-2 py-1.5 text-xs ${r.ok ? 'border-emerald-300 bg-emerald-50/50' : 'border-amber-300 bg-amber-50/50'}`}
                    >
                      <div className="font-medium">
                        {r.ok ? '✓' : '!'} {r.nama} · {r.yieldQty} porsi · {r.lines.length} bahan
                      </div>
                      {!r.ok && r.errors[0] && (
                        <div className="text-amber-900">{r.errors[0]}</div>
                      )}
                      <div className="text-muted-foreground mt-0.5">
                        {r.lines.map((l) => (
                          <span key={`${r.nama}-${l.bahanKode}-${l.bahanNama}-${l.qty}`} className="mr-2">
                            {l.match === 'none'
                              ? `✗ ${l.bahanKode || l.bahanNama}`
                              : `→ ${l.productKode || l.productNama}`}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>Batal</Button>
            <Button
              onClick={() => void commitImport()}
              disabled={importing || !(importPreview?.summary?.ready)}
            >
              {importing ? 'Memproses…' : `Import ${importPreview?.summary?.ready || 0} resep siap`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
