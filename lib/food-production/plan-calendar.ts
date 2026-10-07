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
  /** Jumlah penerima makan (panel Kategori Porsi) — dipakai bila ada. */
  penerimaPorsi?: number;
  /** Penerima per kategori dari panel — rencana lain di dapur+tanggal yang sama berbagi angka ini. */
  penerimaByKategori?: Record<string, number>;
  kitchenId?: string;
}

export function planPorsiLabel(p: Pick<PlanDateFields, 'penerimaPorsi' | 'totalTargetPorsi'>): number {
  const n = Number(p.penerimaPorsi);
  return n > 0 ? n : (Number(p.totalTargetPorsi) || 0);
}

/**
 * Total penerima satu hari: rencana dari panel Kategori Porsi digabung per dapur (kategori yang
 * sama dihitung sekali), rencana tanpa panel dijumlah apa adanya. Rencana batal tidak dihitung.
 */
export function dayPenerimaPorsi(
  plans: Array<Pick<PlanDateFields, 'status' | 'penerimaPorsi' | 'totalTargetPorsi' | 'penerimaByKategori' | 'kitchenId'>>,
): number {
  const byKitchen = new Map<string, Map<string, number>>();
  let loose = 0;
  for (const p of plans) {
    if (p.status === 'CANCELLED') continue;
    const kp = p.penerimaByKategori;
    if (!kp || !Object.keys(kp).length) {
      loose += planPorsiLabel(p);
      continue;
    }
    const kitchen = String(p.kitchenId || '');
    const merged = byKitchen.get(kitchen) ?? new Map<string, number>();
    for (const [k, n] of Object.entries(kp)) merged.set(k, Math.max(merged.get(k) || 0, Number(n) || 0));
    byKitchen.set(kitchen, merged);
  }
  let total = loose;
  for (const merged of byKitchen.values()) for (const n of merged.values()) total += n;
  return Math.round(total);
}

/** Rencana aktif lain di dapur+tanggal yang sama dengan kategori yang beririsan. */
export function overlappingPlans<
  T extends { id?: string; status?: string; kitchenId?: string; tanggal?: string | Date | null; kategoriPorsiList?: string[] },
>(plan: T, others: T[]): T[] {
  const kp = new Set(plan.kategoriPorsiList || []);
  const day = dateKey(plan.tanggal);
  return others.filter((o) => o.id !== plan.id
    && o.status !== 'CANCELLED'
    && String(o.kitchenId || '') === String(plan.kitchenId || '')
    && dateKey(o.tanggal) === day
    && (!kp.size || !(o.kategoriPorsiList || []).length || (o.kategoriPorsiList || []).some((k) => kp.has(k))));
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
