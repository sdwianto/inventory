'use client';

// Client-side user cache for UI (otorisasi sebenarnya di cookie HttpOnly + server).
import { setActingTenantIdLocal } from '@/lib/acting-tenant-client';
import type { SessionUser } from '@/types/auth';

const KEY = 'inventory_user';

export const setUser = (u: SessionUser | null | undefined): void => {
  if (typeof window === 'undefined') return;
  if (u) localStorage.setItem(KEY, JSON.stringify(u));
  else localStorage.removeItem(KEY);
};

export const getUser = (): SessionUser | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) as SessionUser : null;
  } catch {
    return null;
  }
};

export const clearUser = (): void => {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(KEY);
  try {
    localStorage.removeItem('erp_acting_tenant_id');
  } catch {
    /* ignore */
  }
};

interface AuthMeResponse {
  user?: SessionUser;
}

/** Sinkronkan profil dari session server (/api/auth/me). */
export async function syncSessionUser(): Promise<SessionUser | null> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) {
      clearUser();
      return null;
    }
    const data = await res.json() as AuthMeResponse;
    if (data?.user) {
      if (data.user.role === 'MASTER' && data.user.actingTenantId) {
        setActingTenantIdLocal(data.user.actingTenantId);
      }
      setUser(data.user);
      return data.user;
    }
    clearUser();
    return null;
  } catch {
    return getUser();
  }
}
