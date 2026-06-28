'use client';

/** fetch ke /api dengan cookie session (credentials: include). */
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
  const isApi = url.startsWith('/api') || url.includes('/api/');
  return fetch(input, {
    ...init,
    credentials: isApi ? 'include' : init.credentials,
  });
}
