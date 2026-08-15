/** Klasifikasi peran + gudang. Jaga tetap selaras dengan sales/lib/produk/classify-grup.ts */

import {
  isFinishedGoodRole,
  normalizeItemRole,
  type ItemRole,
} from '@/lib/food-production/item-role';
import type { WarehouseCode } from '@/lib/api/warehouses';

export const WEAK_PRODUK_GRUP = new Set(['', 'Umum', 'Lainnya']);

export const PRODUK_GRUP_SORT_ORDER = [
  'Buah',
  'Sayuran',
  'Protein Hewani',
  'Bumbu',
  'Roti',
  'Sembako',
  'Minuman',
  'Makanan Ringan',
  'Palen',
  'Toiletries',
  'Lainnya',
  'Umum',
] as const;

type GrupHint = { grup: string; hints: string[] };

export const GRUP_NAME_HINTS: GrupHint[] = [
  {
    grup: 'Toiletries',
    hints: [
      'sabun', 'deterjen', 'detergen', 'pemutih', 'sunlight', 'lifebuoy',
      'pasta gigi', 'disinfektan', 'hand soap', 'pembersih',
    ],
  },
  {
    grup: 'Palen',
    hints: [
      'foil', 'plastik', 'kresek', 'tray', 'sedotan', 'alumunium', 'aluminium',
      'wrapping', 'cling', 'kemasan', 'cup ', 'tutup',
    ],
  },
  {
    grup: 'Bumbu',
    hints: [
      'desaku', 'ladaku', 'marinasi', 'bumbu', 'garam', 'merica',
      'ketumbar', 'kunyit', 'lengkuas', 'jahe', 'saos', 'saus', 'kecap',
      'terasi', 'kaldu', 'abon', 'msg', 'penyedap', 'cabe bubuk', 'cabai kering',
      'bbk', 'knorr', 'knoor',
    ],
  },
  {
    grup: 'Buah',
    hints: [
      'alpukat', 'anggur', 'apel', 'pisang', 'jeruk', 'mangga', 'semangka',
      'melon', 'pepaya', 'buah',
    ],
  },
  {
    grup: 'Sayuran',
    hints: [
      'sayur', 'wortel', 'bayam', 'kangkung', 'sawi', 'brokoli', 'kubis',
      'bawang', 'tomat', 'kentang', 'jagung', 'selada',
    ],
  },
  {
    grup: 'Protein Hewani',
    hints: ['daging', 'ayam', 'sapi', 'ikan', 'udang', 'telur', 'cumi'],
  },
  { grup: 'Roti', hints: ['roti', 'bakery', 'bread'] },
  {
    grup: 'Minuman',
    hints: ['susu', 'air kelapa', 'minuman', 'sirup', ' teh', 'teh ', 'kopi'],
  },
  {
    grup: 'Sembako',
    hints: ['beras', 'gula', 'minyak', 'tepung', 'mie ', 'terigu'],
  },
];

const GRUP_MATRIX: Record<string, { itemRole: ItemRole; gudangKode: WarehouseCode }> = {
  Buah: { itemRole: 'INGREDIENT', gudangKode: 'GBASAH' },
  Sayuran: { itemRole: 'INGREDIENT', gudangKode: 'GBASAH' },
  'Protein Hewani': { itemRole: 'INGREDIENT', gudangKode: 'GBASAH' },
  Roti: { itemRole: 'INGREDIENT', gudangKode: 'GBASAH' },
  Telur: { itemRole: 'INGREDIENT', gudangKode: 'GBASAH' },
  Susu: { itemRole: 'INGREDIENT', gudangKode: 'GBASAH' },
  Daging: { itemRole: 'INGREDIENT', gudangKode: 'GBASAH' },
  Ikan: { itemRole: 'INGREDIENT', gudangKode: 'GBASAH' },
  Basah: { itemRole: 'INGREDIENT', gudangKode: 'GBASAH' },
  Bumbu: { itemRole: 'INGREDIENT', gudangKode: 'GKERING' },
  Sembako: { itemRole: 'INGREDIENT', gudangKode: 'GKERING' },
  Minuman: { itemRole: 'INGREDIENT', gudangKode: 'GKERING' },
  'Makanan Ringan': { itemRole: 'INGREDIENT', gudangKode: 'GKERING' },
  Palen: { itemRole: 'PACKAGING', gudangKode: 'GKERING' },
  Toiletries: { itemRole: 'CONSUMABLE', gudangKode: 'GJANITOR' },
};

const DRY_PROCESSED_HINTS = ['abon', 'kering', 'asin', 'tepung'];

export type ProductClassification = {
  itemRole: ItemRole;
  gudangKode: WarehouseCode;
};

export type ClassificationSource = 'inferred' | 'manual';

export function isWeakProdukGrup(grup: unknown): boolean {
  return WEAK_PRODUK_GRUP.has(String(grup || '').trim());
}

export function suggestProdukGrup(nama: unknown): string | null {
  const n = String(nama || '').toLowerCase();
  if (n.trim().length < 3) return null;
  for (const row of GRUP_NAME_HINTS) {
    if (row.hints.some((h) => n.includes(h))) return row.grup;
  }
  return null;
}

export function sortProdukGrupNames(names: string[]): string[] {
  const rank = (nama: string) => {
    const i = PRODUK_GRUP_SORT_ORDER.indexOf(nama as (typeof PRODUK_GRUP_SORT_ORDER)[number]);
    if (i >= 0) return i;
    return 80;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'id'));
}

export function sortProdukGrupOptions<T extends { nama?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const names = sortProdukGrupNames([String(a.nama || ''), String(b.nama || '')]);
    return names[0] === String(a.nama || '') ? -1 : 1;
  });
}

function isDryProcessedName(nama: string): boolean {
  return DRY_PROCESSED_HINTS.some((h) => nama.includes(h));
}

export function classifyProduct(prod: { grup?: string; nama?: string } | null | undefined): ProductClassification {
  const grup = String(prod?.grup || '').trim();
  const nama = String(prod?.nama || '').toLowerCase();
  const fromGrup = GRUP_MATRIX[grup];
  let result: ProductClassification = fromGrup
    ? { ...fromGrup }
    : { itemRole: 'INGREDIENT', gudangKode: 'GKERING' };

  if (!fromGrup && isWeakProdukGrup(grup)) {
    const suggested = suggestProdukGrup(nama);
    if (suggested && GRUP_MATRIX[suggested]) {
      result = { ...GRUP_MATRIX[suggested] };
    }
  }

  if (result.gudangKode === 'GBASAH' && isDryProcessedName(nama)) {
    result = { ...result, gudangKode: 'GKERING' };
  }
  return result;
}

export function isManualClassification(prod: {
  itemRole?: unknown;
  classificationSource?: unknown;
} | null | undefined): boolean {
  if (isFinishedGoodRole(prod?.itemRole)) return true;
  return String(prod?.classificationSource || '') === 'manual';
}

export function resolveClassificationSource(args: {
  itemRole: unknown;
  gudangKode: unknown;
  inferred: ProductClassification;
}): ClassificationSource {
  if (isFinishedGoodRole(args.itemRole)) return 'manual';
  const role = normalizeItemRole(args.itemRole);
  const gudang = String(args.gudangKode || '').trim().toUpperCase();
  if (role !== args.inferred.itemRole || gudang !== args.inferred.gudangKode) return 'manual';
  return 'inferred';
}
