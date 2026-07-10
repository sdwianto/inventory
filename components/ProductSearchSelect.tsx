'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { vendorDisplayName } from '@/lib/vendor-display';
import ProductStockReminder from '@/components/ProductStockReminder';
import { fetchJson } from '@/lib/fetch-json';
import { primeProductUomsCacheFromProducts } from '@/lib/hooks/use-product-uoms';
import type { ProductUom } from '@/lib/uom/types';

import type { JsonObject } from '@/types/json';
import { str } from '@/types/json';

function productLabel(p: JsonObject | null | undefined) {
  if (!p) return '';
  const vendor = vendorDisplayName(p);
  const vendorSuffix = vendor ? ` · ${vendor}` : '';
  return `${str(p.kode)} — ${str(p.nama)}${vendorSuffix}`;
}

function productSearchText(p: JsonObject) {
  const vendor = vendorDisplayName(p);
  return [p.kode, p.nama, p.grup, p.barcode, vendor, p.vendorTenantId, p.vendorTenantName, p.satuan]
    .map((v) => str(v))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export default function ProductSearchSelect({
  value,
  onChange,
  onProductPick,
  selectedProduct,
  syncSource,
  withWarehouseStock = true,
  placeholder = 'Cari / pilih produk…',
  className,
}: {
  value?: string;
  onChange: (id: string) => void;
  onProductPick?: (product: JsonObject) => void;
  selectedProduct?: JsonObject | null;
  syncSource?: string;
  withWarehouseStock?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<JsonObject[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolved, setResolved] = useState<JsonObject | null>(selectedProduct || null);

  useEffect(() => {
    if (selectedProduct) setResolved(selectedProduct);
  }, [selectedProduct]);

  useEffect(() => {
    if (!value) {
      setResolved(null);
      return;
    }
    if (resolved && str(resolved.id) === value) return;
    let cancelled = false;
    fetchJson<JsonObject>(`/api/products/${value}`)
      .then((p) => {
        if (cancelled || !p?.id) return;
        setResolved(p);
        primeProductUomsCacheFromProducts([p as { id?: string; uoms?: ProductUom[] }]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [value, resolved]);

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      setLoading(true);
      let url = `/api/products?q=${encodeURIComponent(q)}&limit=50&includeUom=1`;
      if (withWarehouseStock) url += '&withWarehouseStock=1';
      if (syncSource) url += `&syncSource=${encodeURIComponent(syncSource)}`;
      fetchJson<JsonObject[] | { items?: JsonObject[] }>(url)
        .then((data) => {
          const rows = Array.isArray(data) ? data : (data?.items || []);
          setItems(rows);
          if (rows.length) {
            primeProductUomsCacheFromProducts(rows as Array<{ id?: string; uoms?: ProductUom[] }>);
          }
        })
        .catch(() => setItems([]))
        .finally(() => setLoading(false));
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [open, q, syncSource, withWarehouseStock]);

  const selected = useMemo(() => {
    if (resolved && str(resolved.id) === value) return resolved;
    return items.find((p) => str(p.id) === value) || null;
  }, [resolved, items, value]);

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'w-full justify-between h-9 px-2 font-normal text-sm',
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate text-left">
            {selected ? productLabel(selected) : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[280px] p-0 z-[200]" align="start">
        <Command
          filter={(itemValue, search) => {
            if (!search) return 1;
            return itemValue.includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput
            placeholder="Ketik kode, nama, grup, vendor…"
            value={q}
            onValueChange={setQ}
          />
          <CommandList className="max-h-56">
            {loading && <div className="p-3 text-sm text-slate-500">Memuat…</div>}
            {!loading && items.length === 0 && (
              <CommandEmpty>{q ? 'Produk tidak ditemukan.' : 'Ketik untuk mencari produk…'}</CommandEmpty>
            )}
            <CommandGroup>
              {items.map((p) => (
                <CommandItem
                  key={str(p.id)}
                  value={productSearchText(p)}
                  onSelect={() => {
                    const pid = str(p.id);
                    setResolved(p);
                    onProductPick?.(p);
                    onChange(pid === value ? '' : pid);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4 shrink-0', value === str(p.id) ? 'opacity-100' : 'opacity-0')} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{str(p.nama)}</div>
                    <div className="flex flex-wrap gap-1 text-[10px] text-slate-500">
                      <span className="font-mono">{str(p.kode)}</span>
                      {str(p.satuan) && <span>· {str(p.satuan)}</span>}
                      {vendorDisplayName(p) && <span>· {vendorDisplayName(p)}</span>}
                      <ProductStockReminder product={p} className="contents" />
                    </div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
