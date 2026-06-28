import { format, isSameDay, startOfDay } from 'date-fns';
import { id as localeId } from 'date-fns/locale';

export type PoStatusVisualVariant = 'solid' | 'ring' | 'ring-thick' | 'striped';

export const PO_STATUS_STYLE = {
  DRAFT: 'bg-slate-100 text-slate-700 border-slate-300',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800 border-amber-300',
  APPROVED: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  REJECTED: 'bg-red-100 text-red-800 border-red-300',
  SUBMITTED: 'bg-blue-100 text-blue-800 border-blue-300',
  CONFIRMED: 'bg-indigo-100 text-indigo-800 border-indigo-300',
  PARTIAL_SHIPPED: 'bg-amber-100 text-amber-800 border-amber-300',
  SHIPPED: 'bg-orange-100 text-orange-800 border-orange-300',
  PARTIAL_RECEIVED: 'bg-teal-100 text-teal-800 border-teal-300',
  RECEIVED: 'bg-green-100 text-green-800 border-green-300',
  INVOICED: 'bg-purple-100 text-purple-800 border-purple-300',
} as const;

export const PO_STATUS_DOT = {
  DRAFT: 'bg-slate-500',
  PENDING_APPROVAL: 'bg-amber-600',
  APPROVED: 'bg-emerald-600',
  REJECTED: 'bg-red-600',
  SUBMITTED: 'bg-blue-600',
  CONFIRMED: 'bg-indigo-600',
  PARTIAL_SHIPPED: 'bg-amber-600',
  SHIPPED: 'bg-orange-600',
  PARTIAL_RECEIVED: 'bg-teal-600',
  RECEIVED: 'bg-green-600',
  INVOICED: 'bg-purple-600',
} as const;

/** Palet & pola visual status PO — warna saling jauh; partial pakai ring/garis. */
export const PO_STATUS_VISUAL = {
  DRAFT: { color: '#64748b', variant: 'solid' },
  PENDING_APPROVAL: { color: '#d97706', variant: 'ring' },
  APPROVED: { color: '#059669', variant: 'ring' },
  REJECTED: { color: '#dc2626', variant: 'solid' },
  SUBMITTED: { color: '#1d4ed8', variant: 'solid' },
  CONFIRMED: { color: '#7c3aed', variant: 'ring' },
  PARTIAL_SHIPPED: { color: '#b45309', variant: 'striped' },
  SHIPPED: { color: '#dc2626', variant: 'solid' },
  PARTIAL_RECEIVED: { color: '#0284c7', variant: 'striped' },
  RECEIVED: { color: '#15803d', variant: 'solid' },
  INVOICED: { color: '#db2777', variant: 'ring-thick' },
} as const satisfies Record<string, { color: string; variant: PoStatusVisualVariant }>;

export type PoStatus = keyof typeof PO_STATUS_VISUAL;

/** @deprecated gunakan PO_STATUS_VISUAL */
export const PO_STATUS_COLOR = Object.fromEntries(
  Object.entries(PO_STATUS_VISUAL).map(([k, v]) => [k, v.color]),
) as Record<PoStatus, string>;

export const PO_STATUS_ORDER: PoStatus[] = [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUBMITTED', 'CONFIRMED', 'PARTIAL_SHIPPED',
  'SHIPPED', 'PARTIAL_RECEIVED', 'RECEIVED', 'INVOICED',
];

export interface PoArrivalFields {
  tanggalKedatangan?: string | Date | null;
  tanggal?: string | Date | null;
  status?: string;
}

type DateInput = string | Date | null | undefined;

export function getPoArrivalDate(po: PoArrivalFields | null | undefined): Date | null {
  const raw = po?.tanggalKedatangan || po?.tanggal;
  if (!raw) return null;
  return startOfDay(new Date(raw));
}

export function dateKey(d: DateInput): string {
  if (!d) return '';
  return format(startOfDay(new Date(d)), 'yyyy-MM-dd');
}

export function groupPosByArrivalDate<T extends PoArrivalFields>(
  pos: T[] | null | undefined,
): Record<string, T[]> {
  const map: Record<string, T[]> = {};
  for (const po of pos || []) {
    const key = dateKey(getPoArrivalDate(po));
    if (!key) continue;
    if (!map[key]) map[key] = [];
    map[key].push(po);
  }
  return map;
}

export function statusesOnDay(dayPos: PoArrivalFields[] | null | undefined): PoStatus[] {
  const set = new Set((dayPos || []).map((p) => p.status).filter(Boolean));
  return PO_STATUS_ORDER.filter((s) => set.has(s));
}

export function formatArrivalLabel(d: DateInput): string {
  if (!d) return '';
  return format(new Date(d), 'EEEE, d MMMM yyyy', { locale: localeId });
}

export function isSameArrivalDay(a: DateInput, b: DateInput): boolean {
  if (!a || !b) return false;
  return isSameDay(
    getPoArrivalDate({ tanggalKedatangan: a }) || new Date(a),
    getPoArrivalDate({ tanggalKedatangan: b }) || new Date(b),
  );
}
