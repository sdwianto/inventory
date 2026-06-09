'use client';

// Client-side user cache for UI (otorisasi sebenarnya di cookie HttpOnly + server).
const KEY = 'inventory_user';

export const setUser = (u) => {
  if (typeof window === 'undefined') return;
  if (u) localStorage.setItem(KEY, JSON.stringify(u));
  else localStorage.removeItem(KEY);
};

export const getUser = () => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export const clearUser = () => {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(KEY);
};

/** Sinkronkan profil dari session server (/api/auth/me). */
export async function syncSessionUser() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) {
      clearUser();
      return null;
    }
    const data = await res.json();
    if (data?.user) {
      setUser(data.user);
      return data.user;
    }
    clearUser();
    return null;
  } catch {
    return getUser();
  }
};
