'use client';

const STORAGE_KEY = 'erp_acting_tenant_id';

export function getActingTenantId() {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setActingTenantId(tenantId) {
  if (typeof window === 'undefined') return;
  try {
    if (tenantId) localStorage.setItem(STORAGE_KEY, tenantId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('erp-scope-change'));
}
