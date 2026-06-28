'use client';

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export interface SummaryStatCardProps {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  icon?: LucideIcon;
  sub?: ReactNode;
  colSpan?: 1 | 2 | 3;
}

export function SummaryStatCard({
  label,
  value,
  valueClassName = '',
  icon: Icon,
  sub,
  colSpan = 1,
}: SummaryStatCardProps) {
  const spanClass = colSpan === 2 ? 'lg:col-span-2' : colSpan === 3 ? 'lg:col-span-3' : '';
  return (
    <Card className={spanClass}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs text-slate-500">{label}</div>
          {Icon && <Icon className="w-4 h-4 text-orange-500 shrink-0" />}
        </div>
        <div className={`text-2xl font-bold mt-1 ${valueClassName}`}>{value}</div>
        {sub ? <div className="text-xs mt-1 text-slate-500">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}

interface ListSummaryCardsProps {
  items?: SummaryStatCardProps[];
  className?: string;
}

/** Grid kartu ringkasan — pola sama dengan halaman Laporan. */
export default function ListSummaryCards({ items = [], className = '' }: ListSummaryCardsProps) {
  if (!items.length) return null;
  return (
    <div className={`grid grid-cols-2 lg:grid-cols-4 gap-3 ${className}`}>
      {items.map((item) => (
        <SummaryStatCard key={item.label} {...item} />
      ))}
    </div>
  );
}
