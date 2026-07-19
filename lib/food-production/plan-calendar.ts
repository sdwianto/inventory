import { format, startOfDay } from 'date-fns';
import { id as localeId } from 'date-fns/locale';
import type { ProductionPlanStatus } from '@/lib/food-production/production-plan';

export const PLAN_STATUS_DOT: Record<ProductionPlanStatus, string> = {
  DRAFT: 'bg-slate-500',
  SUBMITTED: 'bg-blue-600',
  APPROVED: 'bg-emerald-600',
  PROCESSING: 'bg-amber-600',
  COMPLETED: 'bg-green-700',
  CANCELLED: 'bg-red-500',
};

export const PLAN_STATUS_BADGE: Record<ProductionPlanStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 border-slate-300',
  SUBMITTED: 'bg-blue-100 text-blue-800 border-blue-300',
  APPROVED: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  PROCESSING: 'bg-amber-100 text-amber-800 border-amber-300',
  COMPLETED: 'bg-green-100 text-green-800 border-green-300',
  CANCELLED: 'bg-red-100 text-red-800 border-red-300',
};

export const PLAN_STATUS_ORDER: ProductionPlanStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'PROCESSING',
  'COMPLETED',
  'CANCELLED',
];

export interface PlanDateFields {
  tanggal?: string | Date | null;
  status?: string;
  /** Optional — shown on date strip (total porsi target that day). */
  totalTargetPorsi?: number;
}

type DateInput = string | Date | null | undefined;

export function dateKey(d: DateInput): string {
  if (!d) return '';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  return format(startOfDay(new Date(d)), 'yyyy-MM-dd');
}

export function groupPlansByDate<T extends PlanDateFields>(
  plans: T[] | null | undefined,
): Record<string, T[]> {
  const map: Record<string, T[]> = {};
  for (const plan of plans || []) {
    const key = dateKey(plan.tanggal);
    if (!key) continue;
    if (!map[key]) map[key] = [];
    map[key].push(plan);
  }
  return map;
}

export function statusesOnDay(dayPlans: PlanDateFields[] | null | undefined): ProductionPlanStatus[] {
  const set = new Set(
    (dayPlans || [])
      .map((p) => String(p.status || ''))
      .filter(Boolean) as ProductionPlanStatus[],
  );
  return PLAN_STATUS_ORDER.filter((s) => set.has(s));
}

export function formatPlanDateLabel(d: DateInput): string {
  if (!d) return '';
  const key = dateKey(d);
  return format(new Date(`${key}T12:00:00`), 'EEEE, d MMMM yyyy', { locale: localeId });
}

export function monthRangeIso(month: Date): { from: string; to: string } {
  const y = month.getFullYear();
  const m = month.getMonth();
  const from = format(new Date(y, m, 1), 'yyyy-MM-dd');
  const to = format(new Date(y, m + 1, 0), 'yyyy-MM-dd');
  return { from, to };
}
