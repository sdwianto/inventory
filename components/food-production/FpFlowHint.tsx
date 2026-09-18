'use client';

import { cn } from '@/lib/utils';
import type { FpFlowStep } from '@/lib/food-production/fp-flow';

const STEPS: Array<{ id: FpFlowStep; label: string }> = [
  { id: 'menu', label: 'Susun menu' },
  { id: 'approve', label: 'Setujui RPN' },
  { id: 'fulfill', label: 'Belanja atau ambil bahan' },
  { id: 'result', label: 'Hasil produksi' },
];

export default function FpFlowHint({
  active,
  className,
}: {
  active: FpFlowStep;
  className?: string;
}) {
  return (
    <p className={cn('text-xs text-slate-500 flex flex-wrap gap-x-1.5 gap-y-0.5', className)}>
      {STEPS.map((step, i) => (
        <span key={step.id} className="inline-flex items-center gap-1.5">
          {i > 0 ? <span className="text-slate-300" aria-hidden>→</span> : null}
          <span
            className={cn(
              step.id === active && 'font-semibold text-slate-800 underline underline-offset-2',
            )}
          >
            {step.label}
          </span>
        </span>
      ))}
    </p>
  );
}
