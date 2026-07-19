/**
 * Bank resep SPPG — import Excel (.xlsx) + paket contoh dengan mapping ke master produk.
 */

import * as XLSX from 'xlsx';
import { normalizeRecipeNama } from '@/lib/food-production/recipe';

export const RECIPE_IMPORT_HEADERS = [
  'nama_resep',
  'yield_porsi',
  'effective_date',
  'waste_pct',
  'catatan',
  'bahan_kode',
  'bahan_nama',
  'qty',
  'satuan',
  'notes',
] as const;

export type RecipeImportProduct = {
  id: string;
  kode: string;
  nama: string;
  satuan?: string;
  itemRole?: string;
  aktif?: boolean;
};

export type RecipeImportLineDraft = {
  bahanKode: string;
  bahanNama: string;
  qty: number;
  satuan: string;
  notes?: string;
  productId?: string;
  productKode?: string;
  productNama?: string;
  match: 'kode' | 'nama' | 'none';
};

export type RecipeImportDraft = {
  nama: string;
  yieldQty: number;
  effectiveDate: string;
  wastePct?: number;
  catatan?: string;
  lines: RecipeImportLineDraft[];
  ok: boolean;
  errors: string[];
};

export type RecipeImportParseResult = {
  recipes: RecipeImportDraft[];
  errors: string[];
};

type Cell = string | number | boolean | null | undefined;

/** Baris data paket contoh (tanpa header). */
export const MBG_RECIPE_SEED_ROWS: Cell[][] = [
  ['Nasi Putih', 100, '2026-07-17', 2, 'Menu pokok harian', '', 'Beras', 12, 'KG', ''],
  ['Nasi Putih', 100, '2026-07-17', 2, '', '', 'Air Minum', 18, 'L', ''],
  ['Ayam Goreng Crispy', 100, '2026-07-17', 5, 'Lauk hewani', '', 'Ayam', 20, 'KG', ''],
  ['Ayam Goreng Crispy', 100, '2026-07-17', 5, '', '', 'Tepung Terigu', 3, 'KG', ''],
  ['Ayam Goreng Crispy', 100, '2026-07-17', 5, '', '', 'Minyak Goreng', 4, 'L', ''],
  ['Ayam Goreng Crispy', 100, '2026-07-17', 5, '', '', 'Bawang Putih', 0.5, 'KG', ''],
  ['Tempe Orek', 100, '2026-07-17', 3, 'Lauk nabati', '', 'Tempe', 10, 'KG', ''],
  ['Tempe Orek', 100, '2026-07-17', 3, '', '', 'Cabai Merah', 1, 'KG', ''],
  ['Tempe Orek', 100, '2026-07-17', 3, '', '', 'Bawang Merah', 1, 'KG', ''],
  ['Tempe Orek', 100, '2026-07-17', 3, '', '', 'Minyak Goreng', 1.5, 'L', ''],
  ['Tahu Bacem', 100, '2026-07-17', 3, '', '', 'Tahu', 12, 'KG', ''],
  ['Tahu Bacem', 100, '2026-07-17', 3, '', '', 'Gula Merah', 1, 'KG', ''],
  ['Tahu Bacem', 100, '2026-07-17', 3, '', '', 'Bawang Putih', 0.3, 'KG', ''],
  ['Sayur Sop', 100, '2026-07-17', 4, 'Sayur', '', 'Wortel', 4, 'KG', ''],
  ['Sayur Sop', 100, '2026-07-17', 4, '', '', 'Kentang', 4, 'KG', ''],
  ['Sayur Sop', 100, '2026-07-17', 4, '', '', 'Kol', 5, 'KG', ''],
  ['Sayur Sop', 100, '2026-07-17', 4, '', '', 'Bawang Putih', 0.4, 'KG', ''],
  ['Tumis Kangkung', 100, '2026-07-17', 3, '', '', 'Kangkung', 8, 'KG', ''],
  ['Tumis Kangkung', 100, '2026-07-17', 3, '', '', 'Cabai Merah', 0.5, 'KG', ''],
  ['Tumis Kangkung', 100, '2026-07-17', 3, '', '', 'Bawang Putih', 0.3, 'KG', ''],
  ['Telur Dadar', 100, '2026-07-17', 3, '', '', 'Telur Ayam', 12, 'KG', ''],
  ['Telur Dadar', 100, '2026-07-17', 3, '', '', 'Minyak Goreng', 1, 'L', ''],
  ['Buah Pisang', 100, '2026-07-17', 1, 'Snack buah', '', 'Pisang', 15, 'KG', ''],
  ['Susu Cair', 100, '2026-07-17', 1, 'Minuman', '', 'Susu', 20, 'L', ''],
];

export const RECIPE_IMPORT_TEMPLATE_ROWS: Cell[][] = [
  ['Contoh Ayam Goreng', 100, '2026-07-17', 5, 'Ganti bahan_kode dengan kode produk Anda', 'AYAM', 'Ayam Fillet', 20, 'KG', 'opsional'],
  ['Contoh Ayam Goreng', 100, '2026-07-17', 5, '', 'TEPUNG', 'Tepung Terigu', 3, 'KG', ''],
  ['Contoh Sayur Sop', 100, '2026-07-17', 3, '', 'WORTEL', 'Wortel', 4, 'KG', ''],
  ['Contoh Sayur Sop', 100, '2026-07-17', 3, '', '', 'Kentang', 4, 'KG', 'match by nama jika kode kosong'],
];

function cellStr(v: Cell): string {
  if (v == null) return '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel date serial → ISO if looks like date column handled separately
    return String(v);
  }
  return String(v).trim();
}

function normalizeKey(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function excelDateToIso(raw: Cell): string {
  if (raw == null || raw === '') return new Date().toISOString().slice(0, 10);
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Excel serial date → JS date (SheetJS epoch)
    const utc = Date.UTC(1899, 11, 30) + raw * 86400000;
    const d = new Date(utc);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = cellStr(raw);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

export function matchImportProduct(
  products: RecipeImportProduct[],
  bahanKode: string,
  bahanNama: string,
): { product: RecipeImportProduct; match: 'kode' | 'nama' } | null {
  const kode = normalizeKey(bahanKode);
  if (kode) {
    const byKode = products.find((p) => normalizeKey(p.kode) === kode);
    if (byKode) return { product: byKode, match: 'kode' };
  }
  const nama = normalizeKey(bahanNama);
  if (!nama) return null;
  const exact = products.filter((p) => normalizeKey(p.nama) === nama);
  if (exact.length >= 1) return { product: exact[0], match: 'nama' };
  const partial = products.filter((p) => {
    const n = normalizeKey(p.nama);
    return n.includes(nama) || nama.includes(n);
  });
  if (partial.length === 1) return { product: partial[0], match: 'nama' };
  return null;
}

/** Parse sheet AOA (baris pertama = header). */
export function parseRecipeImportAoa(
  aoa: Cell[][],
  products: RecipeImportProduct[],
): RecipeImportParseResult {
  const errors: string[] = [];
  const rows = (aoa || []).filter((r) => Array.isArray(r) && r.some((c) => cellStr(c) !== ''));
  if (rows.length < 2) {
    return { recipes: [], errors: ['Excel harus punya header + minimal 1 baris data'] };
  }

  const header = rows[0].map((h) => normalizeKey(cellStr(h)).replace(/\s+/g, '_'));
  const idx = (name: string) => header.indexOf(name);
  for (const h of ['nama_resep', 'qty'] as const) {
    if (idx(h) < 0) errors.push(`Kolom wajib hilang: ${h}`);
  }
  if (idx('bahan_kode') < 0 && idx('bahan_nama') < 0) {
    errors.push('Butuh kolom bahan_kode dan/atau bahan_nama');
  }
  if (errors.length) return { recipes: [], errors };

  type Acc = {
    nama: string;
    yieldQty: number;
    effectiveDate: string;
    wastePct?: number;
    catatan?: string;
    lines: RecipeImportLineDraft[];
    errors: string[];
  };
  const byNama = new Map<string, Acc>();

  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const get = (name: string): Cell => {
      const i = idx(name);
      return i >= 0 ? cols[i] : '';
    };
    const getS = (name: string) => cellStr(get(name));
    const nama = normalizeRecipeNama(getS('nama_resep'));
    if (!nama) {
      errors.push(`Baris ${r + 1}: nama_resep kosong`);
      continue;
    }
    const qty = Number(get('qty'));
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`Baris ${r + 1}: qty harus > 0`);
      continue;
    }
    const bahanKode = getS('bahan_kode');
    const bahanNama = getS('bahan_nama');
    if (!bahanKode && !bahanNama) {
      errors.push(`Baris ${r + 1}: bahan_kode atau bahan_nama wajib`);
      continue;
    }

    const key = normalizeKey(nama);
    let acc = byNama.get(key);
    if (!acc) {
      const yieldQty = Number(get('yield_porsi') || 100);
      const wasteRaw = getS('waste_pct');
      const wastePct = wasteRaw !== '' ? Number(wasteRaw) : undefined;
      acc = {
        nama,
        yieldQty: Number.isFinite(yieldQty) && yieldQty > 0 ? yieldQty : 100,
        effectiveDate: excelDateToIso(get('effective_date')),
        wastePct: wastePct != null && Number.isFinite(wastePct) ? wastePct : undefined,
        catatan: getS('catatan') || undefined,
        lines: [],
        errors: [],
      };
      byNama.set(key, acc);
    }

    const matched = matchImportProduct(products, bahanKode, bahanNama);
    const line: RecipeImportLineDraft = {
      bahanKode,
      bahanNama,
      qty,
      satuan: getS('satuan') || matched?.product.satuan || '',
      notes: getS('notes') || undefined,
      match: matched?.match || 'none',
      productId: matched?.product.id,
      productKode: matched?.product.kode,
      productNama: matched?.product.nama,
    };
    if (!matched) {
      acc.errors.push(
        `Bahan tidak ketemu di master: ${bahanKode || bahanNama} (samakan kode/nama produk)`,
      );
    }
    const dupKey = matched?.product.id || `u:${normalizeKey(bahanKode || bahanNama)}`;
    if (acc.lines.some((l) => (l.productId || `u:${normalizeKey(l.bahanKode || l.bahanNama)}`) === dupKey)) {
      acc.errors.push(`Bahan duplikat: ${bahanKode || bahanNama}`);
      continue;
    }
    acc.lines.push(line);
  }

  const recipes: RecipeImportDraft[] = [...byNama.values()].map((acc) => {
    const errs = [...acc.errors];
    if (!acc.lines.length) errs.push('Tidak ada baris bahan');
    if (acc.wastePct != null && (acc.wastePct < 0 || acc.wastePct > 100)) {
      errs.push('waste_pct harus 0–100');
    }
    return {
      nama: acc.nama,
      yieldQty: acc.yieldQty,
      effectiveDate: acc.effectiveDate,
      wastePct: acc.wastePct,
      catatan: acc.catatan,
      lines: acc.lines,
      ok: errs.length === 0 && acc.lines.every((l) => l.match !== 'none' && l.productId),
      errors: errs,
    };
  });

  return { recipes, errors };
}

export function buildRecipeImportWorkbook(
  dataRows: Cell[][],
  sheetName = 'Resep',
): XLSX.WorkBook {
  const aoa: Cell[][] = [[...RECIPE_IMPORT_HEADERS], ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = RECIPE_IMPORT_HEADERS.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  return wb;
}

export function recipeImportTemplateXlsxBuffer(): Buffer {
  const wb = buildRecipeImportWorkbook(RECIPE_IMPORT_TEMPLATE_ROWS, 'Template');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function recipeImportSeedXlsxBuffer(): Buffer {
  const wb = buildRecipeImportWorkbook(MBG_RECIPE_SEED_ROWS, 'Contoh SPPG');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** Parse .xlsx dari Buffer / ArrayBuffer / base64 (dengan atau tanpa data-URL prefix). */
export function parseRecipeImportExcel(
  input: Buffer | ArrayBuffer | string,
  products: RecipeImportProduct[],
): RecipeImportParseResult {
  let buf: Buffer;
  if (typeof input === 'string') {
    const raw = input.replace(/^data:[^;]+;base64,/, '').trim();
    if (!raw) return { recipes: [], errors: ['File Excel kosong'] };
    buf = Buffer.from(raw, 'base64');
  } else if (input instanceof ArrayBuffer) {
    buf = Buffer.from(input);
  } else {
    buf = input;
  }
  if (!buf.length) return { recipes: [], errors: ['File Excel kosong'] };

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  } catch {
    return { recipes: [], errors: ['File Excel tidak valid (.xlsx)'] };
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { recipes: [], errors: ['Workbook tidak punya sheet'] };
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, defval: '', raw: true }) as Cell[][];
  return parseRecipeImportAoa(aoa, products);
}

/** @deprecated pakai parseRecipeImportExcel / parseRecipeImportAoa */
export function parseRecipeImportCsv(
  csvText: string,
  products: RecipeImportProduct[],
): RecipeImportParseResult {
  const text = String(csvText || '').replace(/^\uFEFF/, '').trim();
  if (!text) return { recipes: [], errors: ['File kosong'] };
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const aoa = lines.map((line) => {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQuotes = !inQuotes;
        continue;
      }
      if (ch === ',' && !inQuotes) {
        out.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
  return parseRecipeImportAoa(aoa, products);
}

/** Legacy alias for tests / seed text. */
export const MBG_RECIPE_SEED_CSV = [
  RECIPE_IMPORT_HEADERS.join(','),
  ...MBG_RECIPE_SEED_ROWS.map((r) => r.map((c) => cellStr(c)).join(',')),
].join('\n');

export function recipeImportTemplateCsv(): string {
  return [
    RECIPE_IMPORT_HEADERS.join(','),
    ...RECIPE_IMPORT_TEMPLATE_ROWS.map((r) => r.map((c) => cellStr(c)).join(',')),
  ].join('\n');
}
