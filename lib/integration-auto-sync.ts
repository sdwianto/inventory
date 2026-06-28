/** Auto-sync katalog vendor — throttle di browser (sekali per sesi / interval). */

const STORAGE_KEY = 'vendor-catalog-auto-sync-at';
const MIN_INTERVAL_MS = 15 * 60 * 1000;

export interface VendorCatalogAutoSyncOptions {
  force?: boolean;
}

export interface VendorCatalogAutoSyncResult {
  skipped?: boolean;
  reason?: string;
  [key: string]: unknown;
}

export async function triggerVendorCatalogAutoSync(
  { force = false }: VendorCatalogAutoSyncOptions = {},
): Promise<VendorCatalogAutoSyncResult> {
  try {
    const last = parseInt(sessionStorage.getItem(STORAGE_KEY) || '0', 10);
    if (!force && Date.now() - last < MIN_INTERVAL_MS) {
      return { skipped: true, reason: 'throttled' };
    }
    const res = await fetch('/api/integrations/auto-sync', { method: 'POST', credentials: 'include' });
    const data = await res.json().catch(() => ({})) as VendorCatalogAutoSyncResult;
    if (res.ok && !data.skipped) {
      sessionStorage.setItem(STORAGE_KEY, String(Date.now()));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('vendor-catalog-synced', { detail: data }));
      }
    }
    return data;
  } catch {
    return { skipped: true, reason: 'network' };
  }
}
