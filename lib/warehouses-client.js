'use client';

export const WAREHOUSES = [
  { kode: 'GKERING', nama: 'Gudang Kering', short: 'Kering' },
  { kode: 'GBASAH', nama: 'Gudang Basah', short: 'Basah' },
];

export function warehouseName(kode) {
  return WAREHOUSES.find((w) => w.kode === kode)?.nama || kode;
}
