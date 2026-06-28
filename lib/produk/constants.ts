import type { JsonObject } from '@/types/json';

export const EMPTY_PRODUCT: JsonObject = {
  kode: '',
  barcode: '',
  nama: '',
  grup: 'Umum',
  satuan: 'PCS',
  gudangKode: 'GKERING',
  hargaBeli: 0,
  stok: 0,
  minStok: 0,
  aktif: true,
  tenantId: '',
};

export const PRODUCT_MANAGE_ROLES = ['SUPERVISOR', 'ADMIN', 'MASTER'] as const;

export const PRODUCT_SELECT_CLASS =
  'w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-200 disabled:bg-slate-50 disabled:text-slate-500';
