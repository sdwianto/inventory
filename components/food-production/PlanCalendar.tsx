'use client';

import { createContext, useContext, useMemo } from 'react';
import { DayPicker, type DayButtonProps } from 'react-day-picker';
import { format, startOfDay } from 'date-fns';
import { id as localeId } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import {
  dateKey,
  groupPlansByDate,
  PLAN_STATUS_DOT,
  PLAN_STATUS_ORDER,
  statusesOnDay,
  type PlanDateFields,
} from '@/lib/food-production/plan-calendar';
import { PLAN_STATUS_LABELS, type ProductionPlanStatus } from '@/lib/food-production/production-plan';

type PlanCalendarContextValue = {
  planByDate: Record<string, PlanDateFields[]>;
  selectedKey: string | null;
  onCreateForDate: (date: Date) => void;
  canCreate: boolean;
};

const PlanCalendarContext = createContext<PlanCalendarContextValue | null>(null);

function usePlanCalendarContext() {
  const ctx = useContext(PlanCalendarContext);
  if (!ctx) throw new Error('PlanDayButton must be used within PlanCalendar');
  return ctx;
}

function PlanStatusDot({ status, size = 'sm' }: { status: ProductionPlanStatus; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cn(
        'inline-block rounded-full',
        PLAN_STATUS_DOT[status] || 'bg-slate-400',
        size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2',
      )}
      title={PLAN_STATUS_LABELS[status] || status}
    />
  );
}

function PlanDayButton({ day, modifiers, className, ...props }: DayButtonProps) {
  const { planByDate, selectedKey, onCreateForDate, canCreate } = usePlanCalendarContext();
  const key = dateKey(day.date);
  const dayPlans = planByDate[key] || [];
  const count = dayPlans.length;
  const flags = statusesOnDay(dayPlans);
  const selected = selectedKey === key;
  const isToday = dateKey(new Date()) === key;

  return (
    <div className="group relative w-full">
      <button
        type="button"
        {...props}
        className={cn(
          'flex min-h-[3rem] w-full flex-col items-center justify-start rounded-md border p-0.5 pt-1 text-xs transition-colors hover:bg-orange-50 hover:border-orange-200',
          selected && 'border-orange-400 bg-orange-50 ring-2 ring-orange-200',
          !selected && isToday && 'border-blue-300 bg-blue-50/50',
          !selected && !isToday && 'border-transparent',
          count > 0 && !selected && 'bg-slate-50/80',
          modifiers.outside && 'opacity-40',
          className,
        )}
        onDoubleClick={(e) => {
          e.preventDefault();
          if (canCreate) onCreateForDate(day.date);
        }}
      >
        <span className={cn('text-xs font-medium leading-none', selected && 'text-orange-700')}>
          {day.date.getDate()}
        </span>
        {count > 0 && (
          <span className="mt-0.5 rounded-full bg-orange-500 px-1.5 py-0 text-[10px] font-bold text-white leading-4">
            {count}
          </span>
        )}
        {flags.length > 0 && (
          <span className="mt-1 flex flex-wrap justify-center gap-0.5 max-w-full px-0.5">
            {flags.map((st) => (
              <PlanStatusDot key={st} status={st} size="sm" />
            ))}
          </span>
        )}
      </button>
      {canCreate && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Buat rencana"
          onClick={(e) => {
            e.stopPropagation();
            onCreateForDate(day.date);
          }}
          className="absolute right-0.5 top-0.5 rounded p-0.5 text-slate-400 opacity-0 transition-opacity hover:bg-orange-100 hover:text-orange-600 group-hover:opacity-100 focus:opacity-100"
          title="Buat rencana"
        >
          <Plus className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

type PlanCalendarProps = {
  plans?: PlanDateFields[];
  month: Date;
  onMonthChange: (month: Date) => void;
  selectedDate?: Date | string | null;
  onSelectDate: (date: Date) => void;
  onCreateForDate: (date: Date) => void;
  canCreate?: boolean;
};

function toSelectedDate(value: Date | string | null | undefined): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return startOfDay(value);
  const key = dateKey(value);
  if (!key) return undefined;
  return startOfDay(new Date(`${key}T12:00:00`));
}

export default function PlanCalendar({
  plans = [],
  month,
  onMonthChange,
  selectedDate,
  onSelectDate,
  onCreateForDate,
  canCreate = true,
}: PlanCalendarProps) {
  const planByDate = useMemo(() => groupPlansByDate(plans), [plans]);
  const selectedKey = selectedDate ? dateKey(selectedDate) : null;
  const selectedAsDate = toSelectedDate(selectedDate);

  const ctx = useMemo(
    () => ({ planByDate, selectedKey, onCreateForDate, canCreate }),
    [planByDate, selectedKey, onCreateForDate, canCreate],
  );

  return (
    <PlanCalendarContext.Provider value={ctx}>
      <div className="space-y-2 overflow-hidden">
        <DayPicker
          mode="single"
          locale={localeId}
          month={month}
          onMonthChange={onMonthChange}
          selected={selectedAsDate}
          onSelect={(date) => {
            if (date) onSelectDate(date);
          }}
          showOutsideDays
          fixedWeeks
          className="w-full p-0"
          classNames={{
            root: 'w-full',
            months: 'relative w-full',
            month: 'relative w-full space-y-1',
            month_caption: 'flex h-7 w-full items-center justify-center px-8',
            caption_label: 'text-sm font-semibold capitalize',
            nav: 'absolute inset-x-0 top-0 z-10 flex h-7 items-center justify-between',
            button_previous: cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'h-6 w-6 shrink-0'),
            button_next: cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'h-6 w-6 shrink-0'),
            month_grid: 'w-full',
            weekdays: 'flex mb-0.5',
            weekday: 'flex-1 text-center text-[10px] font-medium text-slate-500 uppercase',
            week: 'flex w-full mt-0.5 gap-0.5',
            day: 'flex-1 min-w-0 p-0',
            day_button: 'h-auto w-full p-0 font-normal',
          }}
          components={{
            Chevron: ({ orientation }) => (
              orientation === 'left'
                ? <ChevronLeft className="h-4 w-4" />
                : <ChevronRight className="h-4 w-4" />
            ),
            DayButton: PlanDayButton,
          }}
          formatters={{
            formatCaption: (d) => format(d, 'MMMM yyyy', { locale: localeId }),
          }}
        />

        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t pt-2 text-[10px] text-slate-700">
          {PLAN_STATUS_ORDER.map((st) => (
            <span key={st} className="inline-flex items-center gap-1">
              <PlanStatusDot status={st} size="md" />
              {PLAN_STATUS_LABELS[st]}
            </span>
          ))}
          <span className="text-slate-400 w-full sm:w-auto">
            · Klik tanggal = lihat rencana · Klik + = buat rencana
          </span>
        </div>
      </div>
    </PlanCalendarContext.Provider>
  );
}
