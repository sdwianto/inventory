'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { vendorDisplayName } from '@/lib/vendor-display';
import ProductStockReminder from '@/components/ProductStockReminder';

import type { JsonObject } from '@/types/json';
import { str } from '@/types/json';

function productLabel(p: JsonObject | null | undefined) {
  if (!p) return '';
  const vendor = vendorDisplayName(p);
  const vendorSuffix = vendor ? ` · ${vendor}` : '';
  return `${str(p.kode)} — ${str(p.nama)}${vendorSuffix}`;
}

function productSearchText(p: JsonObject) {
  return [p.kode, p.nama, p.grup, p.barcode, p.vendorTenantId, p.vendorTenantName, p.satuan]
    .map((v) => str(v))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export default function ProductSearchSelect({
  products = [],
  value,
  onChange,
  placeholder = 'Cari / pilih produk…',
  className,
}: {
  products?: JsonObject[];
  value?: string;
  onChange: (id: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => products.find((p) => str(p.id) === value) || null,
    [products, value],
  );

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
          <CommandInput placeholder="Ketik kode, nama, grup, vendor…" />
          <CommandList className="max-h-56">
            <CommandEmpty>Produk tidak ditemukan.</CommandEmpty>
            <CommandGroup>
              {products.map((p) => (
                <CommandItem
                  key={str(p.id)}
                  value={productSearchText(p)}
                  onSelect={() => {
                    const pid = str(p.id);
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
