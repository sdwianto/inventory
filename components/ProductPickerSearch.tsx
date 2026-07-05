'use client';

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { fetchJson } from '@/lib/fetch-json';
import type { JsonObject } from '@/types/json';
import { str, num } from '@/types/json';
import { productStockLabel, productStockTitle } from '@/lib/uom/display';

interface ProductPickerSearchProps {
  open: boolean;
  withWarehouseStock?: boolean;
  onSelect: (product: JsonObject) => void;
  limit?: number;
}

export default function ProductPickerSearch({
  open,
  withWarehouseStock = false,
  onSelect,
  limit = 50,
}: ProductPickerSearchProps) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<JsonObject[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      setLoading(true);
      let url = `/api/products?q=${encodeURIComponent(q)}&limit=${limit}`;
      if (withWarehouseStock) url += '&withWarehouseStock=1';
      fetchJson<JsonObject[]>(url)
        .then((data) => setItems(Array.isArray(data) ? data : []))
        .catch(() => setItems([]))
        .finally(() => setLoading(false));
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [open, q, limit, withWarehouseStock]);

  if (!open) return null;

  return (
    <div className="space-y-2">
      <Input
        placeholder="Cari kode / nama produk…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      <div className="max-h-64 overflow-y-auto border rounded-md divide-y">
        {loading && <div className="p-3 text-sm text-slate-500">Memuat…</div>}
        {!loading && items.length === 0 && (
          <div className="p-3 text-sm text-slate-400">Ketik untuk mencari produk</div>
        )}
        {items.map((p) => (
          <button
            key={str(p.id)}
            type="button"
            className="w-full text-left px-3 py-2 hover:bg-slate-50 text-sm flex items-center justify-between gap-2"
            onClick={() => onSelect(p)}
          >
            <span className="min-w-0 truncate">
              <span className="font-mono text-xs text-slate-500 mr-2">{str(p.kode)}</span>
              {str(p.nama)}
            </span>
            <span
              className="text-xs text-slate-500 shrink-0 font-medium"
              title={productStockTitle({
                stok: num(p.stok),
                stokDisplay: str(p.stokDisplay) || undefined,
              })}
            >
              {productStockLabel({
                stok: num(p.stok),
                stokDisplay: str(p.stokDisplay) || undefined,
                satuan: str(p.satuan),
              })}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
