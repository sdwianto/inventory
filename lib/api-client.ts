'use client';

/** fetch ke /api dengan cookie session (credentials: include). Default 15s timeout. */

const DEFAULT_TIMEOUT_MS = 15_000;

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
  const isApi = url.startsWith('/api') || url.includes('/api/');
  const withSignal = init.signal ? init : { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) };
  return fetch(input, {
    ...withSignal,
    credentials: isApi ? 'include' : init.credentials,
  });
}
