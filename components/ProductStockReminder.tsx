'use client';

import { formatNumber } from '@/lib/format';
import { WAREHOUSES } from '@/lib/warehouses-client';

/** Pengingat stok gudang di samping vendor — hanya tampil jika qty > 0. */
export default function ProductStockReminder({ product, className }) {
  const byWh = product?.stokByWarehouse;
  if (!byWh) return null;

  const items = WAREHOUSES
    .map((w) => ({ ...w, qty: parseFloat(byWh[w.kode]) || 0 }))
    .filter((w) => w.qty > 0);

  if (items.length === 0) return null;

  return (
    <span className={className}>
      {items.map((w) => (
        <span
          key={w.kode}
          className={
            w.kode === 'GBASAH'
              ? 'rounded bg-blue-50 px-1.5 py-0.5 text-blue-700'
              : 'rounded bg-amber-50 px-1.5 py-0.5 text-amber-800'
          }
          title={`${w.nama}: ${formatNumber(w.qty)} ${product?.satuan || ''}`.trim()}
        >
          {w.short}: {formatNumber(w.qty)}
          {product?.satuan ? ` ${product.satuan}` : ''}
        </span>
      ))}
    </span>
  );
}
