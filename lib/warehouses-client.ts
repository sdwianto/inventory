'use client';

import type { WarehouseDef } from '@/types/client';

export const WAREHOUSES: WarehouseDef[] = [
  { kode: 'GKERING', nama: 'Gudang Kering', short: 'Kering' },
  { kode: 'GBASAH', nama: 'Gudang Basah', short: 'Basah' },
  { kode: 'GJANITOR', nama: 'Gudang Janitor', short: 'Janitor' },
];

export function warehouseName(kode: string | null | undefined): string {
  return WAREHOUSES.find((w) => w.kode === kode)?.nama || kode || '';
}
