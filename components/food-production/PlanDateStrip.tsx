'use client';

import { useEffect, useMemo, useRef } from 'react';
import { addDays, format, startOfDay } from 'date-fns';
import { id as localeId } from 'date-fns/locale';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  dateKey,
  groupPlansByDate,
  PLAN_STATUS_DOT,
  statusesOnDay,
  type PlanDateFields,
} from '@/lib/food-production/plan-calendar';
import { PLAN_STATUS_LABELS, type ProductionPlanStatus } from '@/lib/food-production/production-plan';

const WINDOW_DAYS = 14;

type PlanDateStripProps = {
  plans?: PlanDateFields[];
  month: Date;
  onMonthChange: (month: Date) => void;
  selectedDate?: Date | string | null;
  onSelectDate: (date: Date) => void;
  onCreateForDate?: (date: Date) => void;
  canCreate?: boolean;
};

function toDate(value: Date | string | null | undefined): Date {
  if (value instanceof Date) return startOfDay(value);
  const key = value ? dateKey(value) : dateKey(new Date());
  return startOfDay(new Date(`${key || dateKey(new Date())}T12:00:00`));
}

function dayPorsi(dayPlans: PlanDateFields[]): number {
  return dayPlans.reduce((sum, p) => sum + (Number(p.totalTargetPorsi) || 0), 0);
}

function PlanStatusDot({ status }: { status: ProductionPlanStatus }) {
  return (
    <span
      className={cn('inline-block h-1.5 w-1.5 rounded-full', PLAN_STATUS_DOT[status] || 'bg-slate-400')}
      title={PLAN_STATUS_LABELS[status] || status}
    />
  );
}

export default function PlanDateStrip({
  plans = [],
  month,
  onMonthChange,
  selectedDate,
  onSelectDate,
}: PlanDateStripProps) {
  const planByDate = useMemo(() => groupPlansByDate(plans), [plans]);
  const selected = toDate(selectedDate);
  const selectedKey = dateKey(selected);
  const scrollerRef = useRef<HTMLDivElement>(null);

  /** Center a 14-day window on the selected date. */
  const days = useMemo(() => {
    const start = addDays(selected, -Math.floor(WINDOW_DAYS / 2) + 1);
    return Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(start, i));
  }, [selected]);

  useEffect(() => {
    const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-date="${selectedKey}"]`);
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [selectedKey]);

  function selectDay(d: Date) {
    const next = startOfDay(d);
    onSelectDate(next);
    if (next.getFullYear() !== month.getFullYear() || next.getMonth() !== month.getMonth()) {
      onMonthChange(new Date(next.getFullYear(), next.getMonth(), 1));
    }
  }

  function shiftDays(delta: number) {
    selectDay(addDays(selected, delta));
  }

  return (
    <div className="bg-white border rounded-xl shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-slate-50/80">
        <p className="text-sm font-medium capitalize text-slate-700 truncate">
          {format(selected, 'MMMM yyyy', { locale: localeId })}
        </p>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            aria-label="7 hari sebelumnya"
            onClick={() => shiftDays(-7)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => selectDay(new Date())}
          >
            Hari ini
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            aria-label="7 hari berikutnya"
            onClick={() => shiftDays(7)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="relative flex items-stretch">
        <button
          type="button"
          aria-label="Tanggal sebelumnya"
          onClick={() => shiftDays(-1)}
          className="shrink-0 px-1.5 sm:px-2 text-slate-500 hover:text-slate-900 hover:bg-slate-50 border-r"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>

        <div
          ref={scrollerRef}
          className="flex flex-1 overflow-x-auto scrollbar-thin scroll-smooth snap-x snap-mandatory"
        >
          {days.map((d) => {
            const key = dateKey(d);
            const dayPlans = planByDate[key] || [];
            const count = dayPlans.length;
            const porsi = dayPorsi(dayPlans);
            const flags = statusesOnDay(dayPlans);
            const selectedDay = key === selectedKey;
            const isToday = key === dateKey(new Date());

            return (
              <button
                key={key}
                type="button"
                data-date={key}
                onClick={() => selectDay(d)}
                className={cn(
                  'relative flex min-w-[5.5rem] sm:min-w-[6.5rem] flex-1 flex-col items-center gap-0.5 px-2 py-3 snap-center transition-colors',
                  'hover:bg-orange-50/70',
                  selectedDay && 'bg-orange-50/40',
                  isToday && !selectedDay && 'bg-blue-50/40',
                )}
              >
                <span
                  className={cn(
                    'text-xs sm:text-sm font-medium whitespace-nowrap',
                    selectedDay ? 'text-orange-800' : 'text-slate-800',
                  )}
                >
                  {format(d, 'EEE, d MMM', { locale: localeId })}
                </span>
                <span
                  className={cn(
                    'text-[11px] sm:text-xs whitespace-nowrap',
                    count > 0 ? 'text-slate-700 font-medium' : 'text-slate-400',
                  )}
                >
                  {count > 0
                    ? `${count}${porsi > 0 ? ` · ${porsi.toLocaleString('id-ID')} porsi` : ''}`
                    : '—'}
                </span>
                {flags.length > 0 && (
                  <span className="mt-0.5 flex gap-0.5">
                    {flags.map((st) => (
                      <PlanStatusDot key={st} status={st} />
                    ))}
                  </span>
                )}
                <span
                  className={cn(
                    'absolute inset-x-3 bottom-0 h-0.5 rounded-full transition-colors',
                    selectedDay ? 'bg-slate-900' : 'bg-transparent',
                  )}
                />
              </button>
            );
          })}
        </div>

        <button
          type="button"
          aria-label="Tanggal berikutnya"
          onClick={() => shiftDays(1)}
          className="shrink-0 px-1.5 sm:px-2 text-slate-500 hover:text-slate-900 hover:bg-slate-50 border-l"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
