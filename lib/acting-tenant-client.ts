'use client';

const STORAGE_KEY = 'erp_acting_tenant_id';

export function getActingTenantId(): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

/** Set localStorage saja — dipakai saat restore dari /auth/me. */
export function setActingTenantIdLocal(tenantId: string | null | undefined): void {
  if (typeof window === 'undefined') return;
  try {
    if (tenantId) localStorage.setItem(STORAGE_KEY, tenantId);
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
    if (!tenantId) {
      const res = await fetch('/api/tenant/acting', { method: 'DELETE', credentials: 'include' });
      return res.ok;
    }
    const res = await fetch('/api/tenant/acting', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
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
  setActingTenantIdLocal(tenantId);
  await syncActingTenantToServer(tenantId);
  window.dispatchEvent(new CustomEvent('erp-scope-change'));
}
