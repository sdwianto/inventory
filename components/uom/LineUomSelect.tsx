'use client';

import { useProductUoms } from '@/lib/hooks/use-product-uoms';
import type { ProductUom } from '@/lib/uom/types';

export interface LineUomSelectProps {
  stokId: string;
  uomId?: string;
  onChange: (uom: ProductUom) => void;
  disabled?: boolean;
  className?: string;
}

export default function LineUomSelect({
  stokId,
  uomId,
  onChange,
  disabled,
  className = '',
}: LineUomSelectProps) {
  const { uoms, loading, defaultUom } = useProductUoms(stokId);
  const value = uomId || defaultUom?.id || '';

  if (loading && !uoms.length) {
    return <span className={`text-xs text-slate-400 ${className}`}>…</span>;
  }
  if (uoms.length <= 1) {
    const u = uoms[0] || defaultUom;
    return (
      <div
        className={`h-9 px-2 flex items-center rounded-md border bg-slate-50 text-xs font-medium uppercase ${className}`}
      >
        {u?.satuan || '—'}
      </div>
    );
  }

  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const next = uoms.find((u) => u.id === e.target.value);
        if (next) onChange(next);
      }}
      className={`h-9 w-full text-xs border rounded-md px-2 uppercase ${className}`}
    >
      {uoms.map((u) => (
        <option key={u.id} value={u.id}>
          {u.satuan}{u.isBase ? '' : ` (×${u.factorToBase})`}
        </option>
      ))}
    </select>
  );
}
