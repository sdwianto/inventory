'use client';

import { useEffect } from 'react';

/** Client error hook — kirim ke Sentry envelope bila NEXT_PUBLIC_SENTRY_DSN diset (P1.1a). */
export default function SentryInit() {
  useEffect(() => {
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
    if (!dsn) return;

    const onError = (event: ErrorEvent) => {
      void import('@/lib/sentry-client').then(({ captureClientError }) =>
        captureClientError(event.message, { stack: event.error?.stack }),
      );
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
      void import('@/lib/sentry-client').then(({ captureClientError }) =>
        captureClientError(msg),
      );
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
