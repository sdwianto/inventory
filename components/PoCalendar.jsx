'use client';

import { useMemo } from 'react';
import { DayPicker } from 'react-day-picker';
import { format } from 'date-fns';
import { id as localeId } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import {
  dateKey, groupPosByArrivalDate, PO_STATUS_ORDER, statusesOnDay,
} from '@/lib/po-calendar';
import PoStatusDot, { PoStatusLegendItem } from '@/components/PoStatusDot';

function PoDayButton({ day, poByDate, selectedDate, onSelectDate, onCreateForDate, modifiers, ...props }) {
  const key = dateKey(day.date);
  const dayPos = poByDate[key] || [];
  const count = dayPos.length;
  const flags = statusesOnDay(dayPos);
  const selected = selectedDate && dateKey(selectedDate) === key;
  const isToday = dateKey(new Date()) === key;

  return (
    <button
      type="button"
      {...props}
      onClick={() => onSelectDate(day.date)}
      onDoubleClick={(e) => { e.preventDefault(); onCreateForDate(day.date); }}
      className={cn(
        'group relative flex min-h-[4.5rem] w-full flex-col items-center justify-start rounded-lg border p-1 pt-1.5 text-sm transition-colors hover:bg-orange-50 hover:border-orange-200',
        selected && 'border-orange-400 bg-orange-50 ring-2 ring-orange-200',
        !selected && isToday && 'border-blue-300 bg-blue-50/50',
        !selected && !isToday && 'border-transparent',
        count > 0 && !selected && 'bg-slate-50/80',
        modifiers.outside && 'opacity-40',
      )}
    >
      <span className={cn('text-sm font-medium leading-none', selected && 'text-orange-700')}>
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
            <PoStatusDot key={st} status={st} size="sm" />
          ))}
        </span>
      )}
      <span
        role="button"
        tabIndex={-1}
        onClick={(e) => { e.stopPropagation(); onCreateForDate(day.date); }}
        className="absolute right-0.5 top-0.5 rounded p-0.5 text-slate-400 opacity-0 hover:bg-orange-100 hover:text-orange-600 group-hover:opacity-100 focus:opacity-100"
        title="Buat PO"
      >
        <Plus className="h-3 w-3" />
      </span>
    </button>
  );
}

export default function PoCalendar({
  pos = [],
  month,
  onMonthChange,
  selectedDate,
  onSelectDate,
  onCreateForDate,
}) {
  const poByDate = useMemo(() => groupPosByArrivalDate(pos), [pos]);

  return (
    <div className="space-y-3">
      <DayPicker
        mode="single"
        locale={localeId}
        month={month}
        onMonthChange={onMonthChange}
        selected={selectedDate}
        showOutsideDays
        fixedWeeks
        className="w-full p-0"
        classNames={{
          root: 'w-full',
          months: 'w-full',
          month: 'w-full space-y-2',
          month_caption: 'flex justify-center items-center h-9 relative',
          caption_label: 'text-base font-semibold capitalize',
          nav: 'flex items-center gap-1',
          button_previous: cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'h-8 w-8 absolute left-0'),
          button_next: cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'h-8 w-8 absolute right-0'),
          month_grid: 'w-full',
          weekdays: 'flex mb-1',
          weekday: 'flex-1 text-center text-[11px] font-medium text-slate-500 uppercase',
          week: 'flex w-full mt-1 gap-1',
          day: 'flex-1 min-w-0 p-0',
          day_button: 'h-auto w-full p-0 font-normal',
        }}
        components={{
          Chevron: ({ orientation }) => (
            orientation === 'left'
              ? <ChevronLeft className="h-4 w-4" />
              : <ChevronRight className="h-4 w-4" />
          ),
          DayButton: (btnProps) => (
            <PoDayButton
              {...btnProps}
              poByDate={poByDate}
              selectedDate={selectedDate}
              onSelectDate={onSelectDate}
              onCreateForDate={onCreateForDate}
            />
          ),
        }}
        formatters={{
          formatCaption: (d) => format(d, 'MMMM yyyy', { locale: localeId }),
        }}
      />

      <div className="flex flex-wrap gap-x-4 gap-y-2 border-t pt-3 text-xs text-slate-700">
        {PO_STATUS_ORDER.map((st) => (
          <PoStatusLegendItem key={st} status={st} />
        ))}
        <span className="text-slate-400 w-full sm:w-auto">· Klik tanggal = lihat PO · Klik + = buat PO</span>
      </div>
    </div>
  );
}
