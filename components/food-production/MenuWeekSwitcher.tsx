'use client';

import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { shiftIsoDate } from '@/lib/food-production/production-plan';
import {
  formatWeekRangeId,
  isoWeekdays,
  localIsoDate,
  relativeWeekLabel,
  weekStartFrom,
  weekWindow,
} from '@/lib/food-production/weekly-menu-plan';

const MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function isoFromLocalDate(d: Date): string {
  return localIsoDate(d);
}

function localDateFromIso(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

function chipRange(weekStart: string): string {
  const days = isoWeekdays(weekStart);
  const sen = days[0];
  const jum = days[4];
  if (!sen || !jum) return weekStart;
  const a = Number(sen.slice(8, 10));
  const b = Number(jum.slice(8, 10));
  const m1 = Number(sen.slice(5, 7));
  const m2 = Number(jum.slice(5, 7));
  if (m1 === m2) return `${a}–${b} ${MONTHS_ID[m2 - 1]}`;
  return `${a} ${MONTHS_ID[m1 - 1]} – ${b} ${MONTHS_ID[m2 - 1]}`;
}

export function currentMenuWeekStart(now = new Date()): string {
  const iso = localIsoDate(now);
  const start = weekStartFrom(iso);
  return typeof start === 'string' ? start : iso;
}

export default function MenuWeekSwitcher({
  weekStart,
  onWeekStartChange,
  todayWeekStart,
  compact = false,
}: {
  weekStart: string;
  onWeekStartChange: (weekStart: string) => void;
  todayWeekStart?: string;
  compact?: boolean;
}) {
  const today = todayWeekStart || currentMenuWeekStart();
  const weeks = useMemo(() => weekWindow(weekStart, 2), [weekStart]);
  const [calOpen, setCalOpen] = useState(false);
  const selectedDate = localDateFromIso(weekStart);
  const isThisWeek = weekStart === today;

  function pickWeek(next: string | undefined | null) {
    if (!next) return;
    const start = weekStartFrom(next);
    if (typeof start === 'string') onWeekStartChange(start);
  }

  return (
    <div
      className={cn(
        'rounded-lg border bg-white',
        compact ? 'p-2 space-y-1.5' : 'p-3 space-y-2',
      )}
      data-testid="menu-week-switcher"
    >
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={compact ? 'h-8 w-8 shrink-0' : 'h-9 w-9 shrink-0'}
          aria-label="Minggu sebelumnya"
          onClick={() => pickWeek(shiftIsoDate(weekStart, -7))}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {weeks.map((ws) => {
            const active = ws === weekStart;
            return (
              <button
                key={ws}
                type="button"
                onClick={() => pickWeek(ws)}
                className={cn(
                  'min-w-0 flex-1 rounded-md border px-1 py-1.5 text-center transition-colors',
                  compact ? 'py-1' : 'sm:min-w-[6rem] sm:px-1.5',
                  active
                    ? 'border-orange-400 bg-orange-50 text-orange-900'
                    : 'border-transparent hover:bg-slate-100 text-slate-700',
                )}
              >
                <div className={cn('font-semibold leading-tight', compact ? 'text-[10px]' : 'text-[11px] sm:text-xs')}>
                  {relativeWeekLabel(ws, today)}
                </div>
                <div className={cn('text-slate-500 tabular-nums', compact ? 'text-[9px]' : 'text-[10px]')}>
                  {chipRange(ws)}
                </div>
              </button>
            );
          })}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={compact ? 'h-8 w-8 shrink-0' : 'h-9 w-9 shrink-0'}
          aria-label="Minggu berikutnya"
          onClick={() => pickWeek(shiftIsoDate(weekStart, 7))}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={cn('font-medium text-slate-800', compact ? 'text-xs' : 'text-sm')}>
          {relativeWeekLabel(weekStart, today)}
          <span className="text-slate-500 font-normal"> · {formatWeekRangeId(weekStart)}</span>
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            disabled={isThisWeek}
            onClick={() => pickWeek(today)}
          >
            Minggu ini
          </Button>
          <Popover modal open={calOpen} onOpenChange={setCalOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-8">
                <CalendarDays className="h-3.5 w-3.5 mr-1" />
                Lompat tanggal
              </Button>
            </PopoverTrigger>
            <PopoverContent className="z-[80] w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={selectedDate}
                defaultMonth={selectedDate}
                onSelect={(d) => {
                  if (!d) return;
                  pickWeek(isoFromLocalDate(d));
                  setCalOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}
