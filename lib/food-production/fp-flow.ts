/**
 * Handoff Perencanaan Menu ↔ RPN (tanpa rework komposisi).
 */

import { weekStartFrom } from '@/lib/food-production/weekly-menu-plan';

export const ADHOC_CATATAN_PREFIX = 'ADHOC:';
export const ADHOC_REASON_MIN = 8;
export const WEEKLY_LINKED_COMPOSITION_LOCKED =
  'Komposisi RPN dari papan minggu tidak diubah di sini.';

export type FpFlowStep = 'menu' | 'approve' | 'fulfill' | 'result';

export function isWeeklyLinkedPlan(row: {
  weeklyMenuPlanId?: string | null;
  status?: string;
}): boolean {
  const id = String(row.weeklyMenuPlanId || '').trim();
  if (!id) return false;
  return String(row.status || '').trim() !== 'CANCELLED';
}

export function menuPlanHref(input: {
  kitchenId?: string | null;
  tanggal: string;
}): string {
  const params = new URLSearchParams();
  const start = weekStartFrom(input.tanggal);
  if (typeof start === 'string') params.set('weekStart', start);
  const kitchenId = String(input.kitchenId || '').trim();
  if (kitchenId) params.set('kitchenId', kitchenId);
  const q = params.toString();
  return q ? `/food-production/menu-plan?${q}` : '/food-production/menu-plan';
}

export function planHref(input: {
  productionPlanId?: string | null;
  tanggal?: string | null;
}): string {
  const params = new URLSearchParams();
  const id = String(input.productionPlanId || '').trim();
  const tanggal = String(input.tanggal || '').trim();
  if (id) params.set('productionPlanId', id);
  if (tanggal) params.set('tanggal', tanggal);
  const q = params.toString();
  return q ? `/food-production/plan?${q}` : '/food-production/plan';
}

export function fpFlowStepForPlanStatus(status?: string): FpFlowStep {
  const st = String(status || '').trim();
  if (st === 'COMPLETED') return 'result';
  if (st === 'APPROVED' || st === 'PROCESSING') return 'fulfill';
  return 'approve';
}

export function isAdHocReasonValid(reason: string): boolean {
  return String(reason || '').trim().length >= ADHOC_REASON_MIN;
}

export function isAdHocCatatan(value: string | null | undefined): boolean {
  return String(value || '').trim().toUpperCase().startsWith(ADHOC_CATATAN_PREFIX);
}

export function formatAdHocCatatan(reason: string): string {
  let trimmed = String(reason || '').trim();
  if (!trimmed) return '';
  if (trimmed.toUpperCase().startsWith(ADHOC_CATATAN_PREFIX)) {
    trimmed = trimmed.slice(ADHOC_CATATAN_PREFIX.length).trim();
  }
  if (!trimmed) return '';
  return `${ADHOC_CATATAN_PREFIX} ${trimmed}`;
}

export function adHocCreateBlockedError(plan: {
  noDokumen?: string;
} | null | undefined): string | null {
  if (!plan) return null;
  const no = String(plan.noDokumen || '').trim() || 'RPN';
  return `Hari ini sudah diterbitkan dari Perencanaan Menu (${no}). Ubah di papan, atau batalkan RPN itu dulu.`;
}

export function productionPlanBodyTouchesComposition(body: {
  tanggal?: unknown;
  kitchenId?: unknown;
  lines?: unknown;
  kategoriPorsiList?: unknown;
  kategoriPorsi?: unknown;
}): boolean {
  return body.tanggal !== undefined
    || body.kitchenId !== undefined
    || body.lines !== undefined
    || body.kategoriPorsiList !== undefined
    || body.kategoriPorsi !== undefined;
}

export function weeklyLinkedCompositionLockedError(
  linked: boolean,
  touchesComposition: boolean,
): string | null {
  if (!linked || !touchesComposition) return null;
  return WEEKLY_LINKED_COMPOSITION_LOCKED;
}

export function activeWeeklyLinkedPlanQuery(kitchenId: string, tanggal: string) {
  return {
    kitchenId,
    tanggal,
    weeklyMenuPlanId: { $exists: true, $nin: [null, ''] },
    status: { $ne: 'CANCELLED' },
  };
}
