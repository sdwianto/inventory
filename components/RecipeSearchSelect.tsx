'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export type RecipeSearchOption = {
  id: string;
  kode: string;
  nama: string;
  aktif?: boolean;
};

export default function RecipeSearchSelect({
  value,
  onChange,
  recipes,
  placeholder = 'Ketik kode / nama resep…',
  className,
}: {
  value?: string;
  onChange: (id: string, recipe?: RecipeSearchOption) => void;
  recipes: RecipeSearchOption[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const options = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = recipes.filter((r) => r.aktif !== false || r.id === value);
    if (!needle) return list.slice(0, 80);
    return list
      .filter((r) => {
        const hay = `${r.kode} ${r.nama}`.toLowerCase();
        return hay.includes(needle);
      })
      .slice(0, 80);
  }, [recipes, q, value]);

  const selected = useMemo(
    () => recipes.find((r) => r.id === value) || null,
    [recipes, value],
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
            {selected
              ? `${selected.kode} — ${selected.nama}${selected.aktif === false ? ' (nonaktif)' : ''}`
              : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[280px] p-0 z-[200]" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Ketik kode atau nama resep…"
            value={q}
            onValueChange={setQ}
          />
          <CommandList className="max-h-56">
            <CommandEmpty>
              {q ? 'Resep tidak ditemukan.' : 'Ketik untuk mencari resep…'}
            </CommandEmpty>
            <CommandGroup>
              {options.map((r) => (
                <CommandItem
                  key={r.id}
                  value={`${r.kode} ${r.nama}`}
                  onSelect={() => {
                    onChange(r.id === value ? '' : r.id, r.id === value ? undefined : r);
                    setOpen(false);
                    setQ('');
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4 shrink-0', value === r.id ? 'opacity-100' : 'opacity-0')} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{r.nama}</div>
                    <div className="text-[10px] font-mono text-muted-foreground">
                      {r.kode}{r.aktif === false ? ' · nonaktif' : ''}
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
