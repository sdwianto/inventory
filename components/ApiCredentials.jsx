'use client';

import { useEffect } from 'react';

/** Pastikan semua fetch ke /api mengirim cookie session. */
export default function ApiCredentials() {
  useEffect(() => {
    const orig = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.startsWith('/api') || url.includes('/api/')) {
        return orig(input, { ...init, credentials: init?.credentials ?? 'include' });
      }
      return orig(input, init);
    };
    return () => {
      window.fetch = orig;
    };
  }, []);
  return null;
}
