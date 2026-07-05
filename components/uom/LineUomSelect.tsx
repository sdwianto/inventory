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
    return <span className={`text-xs uppercase ${className}`}>{u?.satuan || '—'}</span>;
  }

  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const next = uoms.find((u) => u.id === e.target.value);
        if (next) onChange(next);
      }}
      className={`text-xs border rounded px-1 py-0.5 uppercase max-w-[5.5rem] ${className}`}
    >
      {uoms.map((u) => (
        <option key={u.id} value={u.id}>
          {u.satuan}{u.isBase ? '' : ` (×${u.factorToBase})`}
        </option>
      ))}
    </select>
  );
}
