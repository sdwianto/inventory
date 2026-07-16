'use client';

const STORAGE_KEY = 'erp_acting_tenant_id';

/** Tenant bootstrap MASTER bukan scope operasional. */
export function isOperationalTenantId(tenantId: string | null | undefined): boolean {
  const tid = String(tenantId || '').trim();
  return Boolean(tid) && tid !== 'master';
}

export function getActingTenantId(): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || '';
    if (!isOperationalTenantId(raw)) {
      if (raw) localStorage.removeItem(STORAGE_KEY);
      return '';
    }
    return raw;
  } catch {
    return '';
  }
}

/** Set localStorage saja — dipakai saat restore dari /auth/me. */
export function setActingTenantIdLocal(tenantId: string | null | undefined): void {
  if (typeof window === 'undefined') return;
  try {
    if (isOperationalTenantId(tenantId)) localStorage.setItem(STORAGE_KEY, String(tenantId).trim());
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export async function syncActingTenantToServer(
  tenantId: string | null | undefined,
): Promise<boolean | null> {
  if (typeof window === 'undefined') return null;
  try {
    if (!isOperationalTenantId(tenantId)) {
      const res = await fetch('/api/tenant/acting', { method: 'DELETE', credentials: 'include' });
      return res.ok;
    }
    const res = await fetch('/api/tenant/acting', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: String(tenantId).trim() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || 'Gagal set tenant operasional');
    }
    return true;
  } catch {
    return false;
  }
}

export async function setActingTenantId(tenantId: string | null | undefined): Promise<void> {
  if (!isOperationalTenantId(tenantId)) {
    setActingTenantIdLocal(null);
    await syncActingTenantToServer(null);
    window.dispatchEvent(new CustomEvent('erp-scope-change'));
    return;
  }
  const ok = await syncActingTenantToServer(tenantId);
  if (ok) {
    setActingTenantIdLocal(tenantId);
    window.dispatchEvent(new CustomEvent('erp-scope-change'));
  }
}

/**
 * Headers helper for Food Production / MASTER scope fetches.
 * Primary acting-tenant carrier is the cookie set via `/api/tenant/acting`.
 * Query `tenantId` is still accepted server-side — append via `withActingTenantQuery` when needed.
 */
export function actingTenantHeaders(): Record<string, string> {
  return {};
}
