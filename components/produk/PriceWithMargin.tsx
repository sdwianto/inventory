'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatIDR } from '@/lib/format';

export function marginPct(hargaBeli: number | string, hargaJual: number | string) {
  const beli = Number(hargaBeli) || 0;
  const jual = Number(hargaJual) || 0;
  if (beli <= 0) return null;
  return Math.round(((jual - beli) / beli) * 1000) / 10;
}

export function hargaFromMarginPct(hargaBeli: number | string, pct: number | string) {
  const beli = Number(hargaBeli) || 0;
  if (beli <= 0) return 0;
  const p = Number(pct);
  if (!Number.isFinite(p)) return 0;
  return Math.round(beli * (1 + p / 100));
}

export function displayMarginPct(hargaBeli: number | string, hargaJual: number | string) {
  const jual = Number(hargaJual) || 0;
  if (jual <= 0) return null;
  return marginPct(hargaBeli, hargaJual);
}

type UomPriceCellProps = {
  hargaBeli: number;
  value: number;
  onChange: (value: number) => void;
  readOnly?: boolean;
};

/** Kompak untuk sel harga di tabel satuan — harga + input margin %. */
export function UomPriceCell({ hargaBeli, value, onChange, readOnly = false }: UomPriceCellProps) {
  const canCalc = Number(hargaBeli) > 0;
  const pct = displayMarginPct(hargaBeli, value);

  if (readOnly) {
    return (
      <div className="text-right text-xs">
        <div className="font-medium">{formatIDR(value)}</div>
        {pct !== null && (
          <p className="text-[10px] text-slate-500 mt-0.5">
            {pct > 0 ? '+' : ''}{pct}%
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1 min-w-[6.5rem]">
      <Input
        type="number"
        min={0}
        className="h-8 text-right text-xs"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value || '0', 10))}
        placeholder="Rp"
      />
      <div className="flex items-center gap-0.5">
        <Input
          type="number"
          step="0.1"
          className="h-7 text-right text-[11px] px-1.5"
          value={canCalc && pct !== null ? pct : ''}
          placeholder="%"
          disabled={!canCalc}
          title={canCalc ? 'Margin % dari harga beli satuan ini' : 'Isi harga beli dulu'}
          onChange={(e) => {
            if (!canCalc) return;
            onChange(hargaFromMarginPct(hargaBeli, e.target.value));
          }}
        />
        <span className="text-[10px] text-slate-500 shrink-0">%</span>
      </div>
    </div>
  );
}

type PriceWithMarginProps = {
  label: string;
  required?: boolean;
  hargaBeli: number;
  value: number;
  onChange: (value: number) => void;
};

export function PriceWithMargin({ label, required, hargaBeli, value, onChange }: PriceWithMarginProps) {
  const pct = displayMarginPct(hargaBeli, value);
  const canCalc = Number(hargaBeli) > 0;

  return (
    <div>
      <Label>
        {label}
        {required ? ' *' : ''}
        {canCalc && pct !== null && (
          <span className="ml-2 text-xs font-normal text-orange-600">({pct > 0 ? '+' : ''}{pct}%)</span>
        )}
      </Label>
      <div className="flex gap-2">
        <div className="flex-1 min-w-0">
          <Input
            type="number"
            min={0}
            value={value}
            onChange={(e) => onChange(parseInt(e.target.value || '0', 10))}
            placeholder="Rp"
          />
        </div>
        <div className="flex items-center gap-1 w-[7.5rem] shrink-0">
          <Input
            type="number"
            step="0.1"
            className="text-right"
            value={canCalc && pct !== null ? pct : ''}
            placeholder="%"
            disabled={!canCalc}
            title={canCalc ? 'Margin % dari harga beli' : 'Isi harga beli dulu'}
            onChange={(e) => {
              if (!canCalc) return;
              onChange(hargaFromMarginPct(hargaBeli, e.target.value));
            }}
          />
          <span className="text-xs text-slate-500">%</span>
        </div>
      </div>
      {canCalc && value > 0 && (
        <p className="text-[11px] text-slate-500 mt-1">
          {formatIDR(value)} · margin {(pct ?? 0) > 0 ? '+' : ''}{pct ?? 0}% dari beli {formatIDR(hargaBeli)}
        </p>
      )}
      {!canCalc && (
        <p className="text-[11px] text-amber-600 mt-1">Isi harga beli untuk menghitung %</p>
      )}
    </div>
  );
}
