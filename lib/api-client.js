'use client';

/** fetch ke /api dengan cookie session (credentials: include). */
export function apiFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url || '';
  const isApi = url.startsWith('/api') || url.includes('/api/');
  return fetch(input, {
    ...init,
    credentials: isApi ? 'include' : init.credentials,
  });
}
