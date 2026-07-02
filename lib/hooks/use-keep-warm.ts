'use client';

import { useEffect } from 'react';

const INTERVAL_MS = 12 * 60 * 1000;

/** Ping /api/health saat tab aktif — kurangi cold start Vercel (P3.5). */
export function useKeepWarm(enabled = true) {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    let timer: ReturnType<typeof setInterval> | null = null;

    const ping = () => {
      if (document.visibilityState !== 'visible') return;
      void fetch('/api/health', { credentials: 'include', cache: 'no-store' }).catch(() => {});
    };

    ping();
    timer = setInterval(ping, INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') ping();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);
}
