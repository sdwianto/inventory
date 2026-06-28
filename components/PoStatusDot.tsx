'use client';

import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { PO_STATUS_VISUAL, type PoStatus } from '@/lib/po-calendar';

type DotSize = 'sm' | 'md' | 'lg';

function dotStyle(status: string | null | undefined): CSSProperties {
  const visual = PO_STATUS_VISUAL[status as PoStatus] || PO_STATUS_VISUAL.DRAFT;
  const { color, variant } = visual;

  switch (variant) {
    case 'ring':
      return {
        backgroundColor: '#ffffff',
        boxShadow: `inset 0 0 0 2px ${color}`,
        border: `1.5px solid ${color}`,
      };
    case 'ring-thick':
      return {
        backgroundColor: '#ffffff',
        boxShadow: `inset 0 0 0 2px ${color}`,
        border: `2.5px solid ${color}`,
      };
    case 'striped':
      return {
        background: `repeating-linear-gradient(-45deg, ${color} 0 2px, #ffffff 2px 4px)`,
        border: `1.5px solid ${color}`,
      };
    default:
      return {
        backgroundColor: color,
        border: `1px solid ${color}`,
      };
  }
}

interface PoStatusDotProps {
  status?: string | null;
  size?: DotSize;
  className?: string;
}

export default function PoStatusDot({ status, size = 'md', className }: PoStatusDotProps) {
  const sizeClass = size === 'sm' ? 'h-2 w-2' : size === 'lg' ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5';

  return (
    <span
      className={cn('inline-block shrink-0 rounded-full', sizeClass, className)}
      style={dotStyle(status)}
      title={status?.replace(/_/g, ' ')}
      aria-hidden
    />
  );
}

export function PoStatusLegendItem({ status }: { status: PoStatus }) {
  const label = status.replace(/_/g, ' ');
  const { variant } = PO_STATUS_VISUAL[status] || PO_STATUS_VISUAL.DRAFT;
  const hint = variant === 'striped'
    ? ' (sebagian — garis)'
    : variant === 'ring' || variant === 'ring-thick'
      ? ' (konfirmasi — ring)'
      : '';

  return (
    <span className="inline-flex items-center gap-1.5" title={`${label}${hint}`}>
      <PoStatusDot status={status} size="md" className="" />
      <span>{label}</span>
    </span>
  );
}
