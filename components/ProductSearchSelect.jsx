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

function productLabel(p) {
  if (!p) return '';
  const vendor = vendorDisplayName(p);
  const vendorSuffix = vendor ? ` · ${vendor}` : '';
  return `${p.kode} — ${p.nama}${vendorSuffix}`;
}

function productSearchText(p) {
  return [p.kode, p.nama, p.grup, p.barcode, p.vendorTenantId, p.vendorTenantName, p.satuan]
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
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => products.find((p) => p.id === value) || null,
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
                  key={p.id}
                  value={productSearchText(p)}
                  onSelect={() => {
                    onChange(p.id === value ? '' : p.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4 shrink-0', value === p.id ? 'opacity-100' : 'opacity-0')} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{p.nama}</div>
                    <div className="flex flex-wrap gap-1 text-[10px] text-slate-500">
                      <span className="font-mono">{p.kode}</span>
                      {p.satuan && <span>· {p.satuan}</span>}
                      {vendorDisplayName(p) && <span>· {vendorDisplayName(p)}</span>}
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
