/** Client-side acting kitchen scope for Multi-Kitchen FP filters. */

const STORAGE_KEY = 'fp_acting_kitchen_id';

export function getActingKitchenId(): string {
  if (typeof window === 'undefined') return '';
  try {
    return String(sessionStorage.getItem(STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function setActingKitchenId(id: string | null | undefined) {
  if (typeof window === 'undefined') return;
  try {
    const v = String(id || '').trim();
    if (!v) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
}

export function actingKitchenHeaders(): Record<string, string> {
  const id = getActingKitchenId();
  return id ? { 'x-acting-kitchen-id': id } : {};
}

/** Merge tenant + kitchen headers for FP fetches. */
export function fpOperationalHeaders(base?: Record<string, string>): Record<string, string> {
  return { ...(base || {}), ...actingKitchenHeaders() };
}
