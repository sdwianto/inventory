import type { ReactNode } from 'react';
import { WAREHOUSES } from '@/lib/warehouses-client';

export function FormSectionTitle({ children }: { children: ReactNode }) {
  return (
    <p className="col-span-2 text-xs font-semibold uppercase tracking-wide text-slate-500 border-t border-slate-100 pt-3 mt-1">
      {children}
    </p>
  );
}

export function WarehousePicker({
  value,
  onChange,
}: {
  value?: string;
  onChange: (kode: string) => void;
}) {
  const current = value || 'GKERING';
  return (
    <div className="grid grid-cols-3 gap-2">
      {WAREHOUSES.map((w) => {
        const selected = current === w.kode;
        const accent =
          w.kode === 'GBASAH'
            ? { border: 'border-blue-500 bg-blue-50', text: 'text-blue-800' }
            : w.kode === 'GJANITOR'
              ? { border: 'border-emerald-500 bg-emerald-50', text: 'text-emerald-800' }
              : { border: 'border-amber-500 bg-amber-50', text: 'text-amber-800' };
        return (
          <button
            key={w.kode}
            type="button"
            onClick={() => onChange(w.kode)}
            className={`rounded-lg border-2 px-3 py-2.5 text-left transition-all ${
              selected
                ? `${accent.border} shadow-sm`
                : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
            }`}
          >
            <span className={`text-sm font-semibold ${selected ? accent.text : 'text-slate-700'}`}>
              {w.nama}
            </span>
          </button>
        );
      })}
    </div>
  );
}
